/**
 * Resolve the stable_id of the Claude Code session that is calling the MCP
 * server.
 *
 * Why this file exists. The server used to do
 *
 *     const myStableId = computeStableId(process.cwd());
 *
 * which is right for claude-hive-mcp (launched with the session's cwd) and
 * wrong here. This plugin's launcher does `cd "$(dirname "$entrypoint")"`
 * before exec'ing bun, so process.cwd() is always the PLUGIN's install
 * directory. Every session on the machine therefore filed its subscriptions
 * under one id belonging to no session at all, the receiver forwarded to that
 * id, and the broker accepted the message for a peer that does not exist.
 *
 * The failure was silent in both directions, so the replacement is built to
 * fail loudly instead:
 *
 *   1. An explicit `stable_id` argument wins, when the caller passes one.
 *   2. Otherwise the session's cwd (captured by the launcher before it cd's
 *      away) is matched against the LIVE peer list the claude-hive broker
 *      itself reports, and that peer's own stable_id is used. Taking the id
 *      from the broker rather than recomputing the hash means the id we file
 *      is by construction the id the broker will resolve at delivery time.
 *   3. If no live peer matches, we do NOT guess. The tool returns an error
 *      naming the cwd it tried, because a guess here is exactly the bug.
 *
 * Matching is done on realpath, so a session registered under
 * /Volumes/Data/Users/... still matches a cwd reached through the
 * /Users/<user>/dev symlink. Different strings, same directory, same session.
 */

import { realpathSync } from "node:fs";

/** Env var the launcher sets to the cwd it was spawned with. */
export const SESSION_CWD_ENV = "SENTRY_CHANNEL_SESSION_CWD";

/** claude-hive's stable ids are the first 12 hex chars of a sha256. */
export const STABLE_ID_RE = /^[0-9a-f]{12}$/;

export interface HivePeer {
  id: string;
  stable_id: string;
  cwd: string;
  git_root?: string | null;
}

export type IdSource = "explicit" | "hive-peer";

export type Resolution =
  | { ok: true; stableId: string; source: IdSource; matchedCwd: string | null }
  | { ok: false; error: string };

/**
 * The cwd the calling session was in, or null when the launcher did not pass
 * it (an older plugin version, or the server started by hand).
 */
export function sessionCwd(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env[SESSION_CWD_ENV] ?? "").trim();
  if (!raw || !raw.startsWith("/")) return null;
  return raw;
}

/** realpath, falling back to the input when the path no longer exists. */
export function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Live peers whose cwd or git_root is the same directory as `cwd`.
 * Returns the distinct stable_ids, so two sessions sharing one workspace
 * collapse to one answer rather than reading as ambiguous.
 */
export function peersAtCwd(peers: readonly HivePeer[], cwd: string): HivePeer[] {
  const want = canonical(cwd);
  return peers.filter(
    (p) =>
      (p.cwd && canonical(p.cwd) === want) ||
      (p.git_root ? canonical(p.git_root) === want : false),
  );
}

export async function resolveSubscriberId(opts: {
  explicitStableId?: string | undefined;
  cwd: string | null;
  listPeers: () => Promise<HivePeer[]>;
}): Promise<Resolution> {
  const explicit = (opts.explicitStableId ?? "").trim();
  if (explicit) {
    if (!STABLE_ID_RE.test(explicit)) {
      return {
        ok: false,
        error: `stable_id must be 12 lowercase hex characters (got ${JSON.stringify(explicit)}). Ask claude-hive's whoami tool for this session's stable id.`,
      };
    }
    return { ok: true, stableId: explicit, source: "explicit", matchedCwd: null };
  }

  const cwd = opts.cwd;
  if (!cwd) {
    return {
      ok: false,
      error:
        `Cannot tell which session is calling: ${SESSION_CWD_ENV} is not set. ` +
        `This plugin's MCP server runs from its own install directory, so its cwd is not the session's. ` +
        `Update the plugin (the launcher passes it from 0.3.0 on), or pass stable_id explicitly — claude-hive's whoami tool reports it.`,
    };
  }

  let peers: HivePeer[];
  try {
    peers = await opts.listPeers();
  } catch (err) {
    return {
      ok: false,
      error:
        `Could not reach the claude-hive broker to identify this session (${String(err)}). ` +
        `Start the broker, or pass stable_id explicitly (claude-hive's whoami tool reports it).`,
    };
  }

  const matches = peersAtCwd(peers, cwd);
  const ids = [...new Set(matches.map((p) => p.stable_id))];

  if (ids.length === 1) {
    return { ok: true, stableId: ids[0]!, source: "hive-peer", matchedCwd: cwd };
  }
  if (ids.length === 0) {
    return {
      ok: false,
      error:
        `No live claude-hive peer is registered for ${cwd}, so there is no session to address events to. ` +
        `Make sure claude-hive is loaded in this session, then retry — or pass stable_id explicitly.`,
    };
  }
  return {
    ok: false,
    error:
      `${ids.length} live claude-hive peers share ${cwd} (${ids.join(", ")}), so the subscription target is ambiguous. ` +
      `Pass stable_id explicitly — claude-hive's whoami tool reports this session's.`,
  };
}
