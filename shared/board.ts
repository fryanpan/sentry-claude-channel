/**
 * Files Sentry issues as tasks on a claude-workspaces board.
 *
 * The receiver is always running, so a board task is the path that still works
 * when no Claude session is up to read the claude-hive message.
 *
 * - A new issue files one task through `POST /api/workspaces/<id>/tasks`.
 * - The same issue again (filed before, or regressed) adds a comment to that
 *   task's thread instead of filing a second task. The issue-to-task map lives
 *   in the bridge's own database, so the board needs no dedupe field.
 * - Each board has its own agent token in the macOS Keychain. The Keychain
 *   entry's name is derived from the board id, so a route cannot point the
 *   bridge at some other secret.
 * - Tokens only ever go to a loopback address. A board that is not on this
 *   machine is not supported.
 */

import { filedTaskFor, recordFiledTask, type BoardRoute } from "./db.ts";
import { LEVEL_RANK, type SentryIssueWebhook, type SentryLevel } from "./types.ts";

export const KEYCHAIN_ACCOUNT = "sentry-claude-channel";

/** The Keychain service name holding the agent token for one board. */
export function keychainServiceFor(workspaceId: string): string {
  return `sentry-claude-channel.board-token.${workspaceId}`;
}

const BOARD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A board id the bridge will build a URL and a Keychain name from. */
export function isValidBoardId(id: string): boolean {
  return BOARD_ID.test(id);
}

/**
 * True when the URL names this machine. Board tokens are only sent to such a
 * URL, so a misrouted project cannot hand a token to another host.
 */
export function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** Read a board's agent token from the macOS Keychain, or null if absent. */
export async function readTokenFromKeychain(workspaceId: string): Promise<string | null> {
  const proc = Bun.spawn(
    ["security", "find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", keychainServiceFor(workspaceId), "-w"],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  return (await proc.exited) === 0 && out ? out : null;
}

/** Replace a board's agent token in the macOS Keychain. True on success. */
export async function writeTokenToKeychain(workspaceId: string, token: string): Promise<boolean> {
  // -U updates the entry in place. The value goes in as an argument, which a
  // local process listing could see for the moment it runs; it never goes to a
  // log or to disk.
  const proc = Bun.spawn(
    ["security", "add-generic-password", "-U", "-a", KEYCHAIN_ACCOUNT, "-s", keychainServiceFor(workspaceId), "-w", token],
    { stdout: "ignore", stderr: "ignore" },
  );
  return (await proc.exited) === 0;
}

export interface BoardDeps {
  fetch: typeof fetch;
  readToken: (workspaceId: string) => Promise<string | null>;
  writeToken?: (workspaceId: string, token: string) => Promise<boolean>;
}

const defaultDeps: BoardDeps = { fetch, readToken: readTokenFromKeychain, writeToken: writeTokenToKeychain };

export type RefreshResult =
  | { kind: "refreshed"; expiresAt: number }
  | { kind: "failed"; error: string };

/**
 * Swap a board's token for a fresh one before it expires. Board tokens last 7
 * days and a live token can refresh itself, so the bridge never needs access
 * to the mint. The receiver calls this once a day for every routed board.
 */
export async function refreshBoardToken(route: BoardRoute, deps: BoardDeps = defaultDeps): Promise<RefreshResult> {
  if (!isLoopbackUrl(route.server_url)) return { kind: "failed", error: "route server_url is not a loopback address" };
  if (!isValidBoardId(route.workspace_id)) return { kind: "failed", error: "route workspace_id is not a valid board id" };
  const token = await deps.readToken(route.workspace_id);
  if (!token) return { kind: "failed", error: `no agent token in the Keychain under ${keychainServiceFor(route.workspace_id)}` };
  try {
    const res = await deps.fetch(`${route.server_url.replace(/\/+$/, "")}/api/board-tokens/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { kind: "failed", error: `refresh returned ${res.status}; the token may be expired or revoked, and the board needs a new one` };
    const fresh = (await res.json()) as { token?: string; expiresAt?: number };
    if (!fresh.token) return { kind: "failed", error: "refresh answered without a token" };
    if (!(await (deps.writeToken ?? writeTokenToKeychain)(route.workspace_id, fresh.token)))
      return { kind: "failed", error: "could not write the refreshed token to the Keychain" };
    return { kind: "refreshed", expiresAt: fresh.expiresAt ?? 0 };
  } catch (err) {
    return { kind: "failed", error: String(err) };
  }
}

export type FileResult =
  | { kind: "skipped"; reason: string }
  | { kind: "filed"; taskId: string }
  | { kind: "commented"; taskId: string }
  | { kind: "failed"; error: string };

function taskBody(payload: SentryIssueWebhook): string {
  const issue = payload.data.issue;
  return [
    `Sentry reported a new ${issue.level} in ${issue.project.slug}.`,
    "",
    `- **Issue:** ${issue.shortId}`,
    `- **Title:** ${issue.title}`,
    ...(issue.culprit ? [`- **Where:** \`${issue.culprit}\``] : []),
    ...(issue.metadata?.value ? [`- **Detail:** ${issue.metadata.value.slice(0, 300)}`] : []),
    `- **Events:** ${issue.count ?? "?"} · **Users:** ${issue.userCount ?? 0}`,
    "",
    `Filed by the Sentry bridge. A repeat of this issue is added below as a comment, not filed again.`,
  ].join("\n");
}

function repeatComment(payload: SentryIssueWebhook): string {
  const issue = payload.data.issue;
  return `Sentry: ${payload.action} again (${issue.level}). Events: ${issue.count ?? "?"}, users: ${issue.userCount ?? 0}. ${issue.permalink}`;
}

/**
 * File or comment for one webhook, per the project's route. Never throws:
 * the receiver acks Sentry whatever happens here.
 */
export async function fileIssueOnBoard(
  route: BoardRoute,
  payload: SentryIssueWebhook,
  deps: BoardDeps = defaultDeps,
): Promise<FileResult> {
  const issue = payload.data.issue;
  if (!["created", "unresolved"].includes(payload.action))
    return { kind: "skipped", reason: `action ${payload.action} is not filed` };
  if (LEVEL_RANK[issue.level as SentryLevel] < LEVEL_RANK[route.min_level])
    return { kind: "skipped", reason: `level ${issue.level} is below ${route.min_level}` };
  if (!isLoopbackUrl(route.server_url))
    return { kind: "failed", error: "route server_url is not a loopback address; refusing to send a token" };
  if (!isValidBoardId(route.workspace_id))
    return { kind: "failed", error: "route workspace_id is not a valid board id" };

  const token = await deps.readToken(route.workspace_id);
  if (!token)
    return { kind: "failed", error: `no agent token in the Keychain under ${keychainServiceFor(route.workspace_id)}` };

  const base = `${route.server_url.replace(/\/+$/, "")}/api/workspaces/${route.workspace_id}`;
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const signal = AbortSignal.timeout(10_000);

  try {
    const existing = filedTaskFor(issue.id, route.workspace_id);
    if (existing) {
      const res = await deps.fetch(`${base}/docs/task:${existing}/threads`, {
        method: "POST",
        headers,
        // The anchor is required; "subject" is the task itself. The server
        // dedupes on requestId, so a webhook Sentry retries posts once.
        body: JSON.stringify({
          text: repeatComment(payload),
          anchor: { kind: "subject" },
          requestId: `sentry-${issue.id}-${payload.action}-${issue.count ?? "0"}`,
        }),
        signal,
      });
      if (!res.ok) return { kind: "failed", error: `comment on ${existing} returned ${res.status}` };
      return { kind: "commented", taskId: existing };
    }

    const res = await deps.fetch(`${base}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: `Fix ${issue.shortId}: ${issue.title}`.slice(0, 160),
        body: taskBody(payload),
        ...(route.goal ? { goal: route.goal } : {}),
        links: [{ kind: "url", url: issue.permalink }],
      }),
      signal,
    });
    if (!res.ok) return { kind: "failed", error: `task create returned ${res.status}` };
    const taskId = ((await res.json()) as { task?: { id?: string } }).task?.id;
    if (!taskId) return { kind: "failed", error: "task create answered without a task id" };
    recordFiledTask(issue.id, route.workspace_id, taskId);
    return { kind: "filed", taskId };
  } catch (err) {
    return { kind: "failed", error: String(err) };
  }
}
