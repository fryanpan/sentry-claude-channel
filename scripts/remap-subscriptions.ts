/**
 * One-off repair for subscriptions filed under the wrong stable_id.
 *
 * Two ways rows went wrong:
 *
 *   - The MCP server derived its id from process.cwd(), which the launcher
 *     had already changed to the plugin's own install directory. Those rows
 *     are addressed to a directory no session lives in, so no session can
 *     ever receive them.
 *   - Older rows hashed a path reached through a symlink (/Users/<me>/dev/x)
 *     while claude-hive registers the physical path (/Volumes/.../dev/x).
 *     Same directory, different string, different hash.
 *
 * The second kind is repairable: realpath tells us the one directory both
 * strings name, so the intended session is unambiguous. The first kind is
 * not — a plugin install directory belongs to no session — and those rows are
 * dropped.
 *
 * Dry-run by default. Pass --apply to write.
 */

import { Database } from "bun:sqlite";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DB_PATH = process.env.SENTRY_CHANNEL_DB ?? `${homedir()}/.sentry-channel.db`;
const HIVE_URL = process.env.CLAUDE_HIVE_URL ?? "http://127.0.0.1:7900";
const APPLY = process.argv.includes("--apply");

function hash(path: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(path);
  return h.digest("hex").slice(0, 12);
}

/**
 * Every workspace path we can name, in both its symlinked and physical
 * spelling, so a row's hash can be traced back to a directory.
 */
function candidatePaths(extraRoots: readonly string[]): string[] {
  const roots = new Set<string>([
    `${homedir()}/dev`,
    ...extraRoots.map((p) => join(p, "..")),
  ]);
  const out = new Set<string>();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(root, e);
      try {
        if (!statSync(p).isDirectory()) continue;
      } catch {
        continue;
      }
      out.add(p);
      try {
        out.add(realpathSync(p));
      } catch {
        /* gone */
      }
    }
  }
  return [...out];
}

async function livePeers(): Promise<Array<{ stable_id: string; cwd: string; git_root: string | null }>> {
  const res = await fetch(`${HIVE_URL}/list-peers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "machine" }),
  });
  if (!res.ok) throw new Error(`claude-hive /list-peers ${res.status}`);
  return (await res.json()) as Array<{ stable_id: string; cwd: string; git_root: string | null }>;
}

const db = new Database(DB_PATH);
const rows = db
  .query("SELECT id, peer_stable_id, project_slug FROM subscriptions ORDER BY id")
  .all() as Array<{ id: number; peer_stable_id: string; project_slug: string }>;

const peers = await livePeers();
const liveIds = new Set(peers.map((p) => p.stable_id));

const candidates = candidatePaths(peers.map((p) => p.cwd));
/** hash -> canonical id for the same directory, when they differ. */
const aliasFix = new Map<string, { canonicalId: string; path: string }>();
for (const p of candidates) {
  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    continue;
  }
  if (real === p) continue;
  const from = hash(p);
  const to = hash(real);
  if (from === to) continue;
  const existing = aliasFix.get(from);
  // Two different directories hashing to one id would be a sha256 collision;
  // guard anyway so an ambiguous case is dropped rather than guessed.
  if (existing && existing.canonicalId !== to) aliasFix.set(from, { canonicalId: "", path: "" });
  else aliasFix.set(from, { canonicalId: to, path: real });
}

type Verdict = "keep-live" | "remap" | "drop-no-session";
const plan: Array<{ id: number; slug: string; from: string; to: string | null; verdict: Verdict }> = [];

for (const r of rows) {
  if (liveIds.has(r.peer_stable_id)) {
    plan.push({ id: r.id, slug: r.project_slug, from: r.peer_stable_id, to: null, verdict: "keep-live" });
    continue;
  }
  const fix = aliasFix.get(r.peer_stable_id);
  if (fix?.canonicalId) {
    plan.push({ id: r.id, slug: r.project_slug, from: r.peer_stable_id, to: fix.canonicalId, verdict: "remap" });
    continue;
  }
  plan.push({ id: r.id, slug: r.project_slug, from: r.peer_stable_id, to: null, verdict: "drop-no-session" });
}

console.log(`db: ${DB_PATH}`);
console.log(`rows before: ${rows.length}`);
for (const p of plan) {
  console.log(
    `  row ${p.id} ${p.slug.padEnd(26)} ${p.from} ${p.verdict}${p.to ? ` -> ${p.to}` : ""}`,
  );
}
const remap = plan.filter((p) => p.verdict === "remap");
const drop = plan.filter((p) => p.verdict === "drop-no-session");
console.log(`keep: ${plan.length - remap.length - drop.length}  remap: ${remap.length}  drop: ${drop.length}`);

if (!APPLY) {
  console.log("\ndry run — pass --apply to write");
  process.exit(0);
}

db.transaction(() => {
  for (const p of remap) {
    // A row may already exist under the canonical id; the table's uniqueness
    // is (peer_stable_id, project_slug), so collapse rather than fail.
    db.run("DELETE FROM subscriptions WHERE peer_stable_id = ? AND project_slug = ? AND id != ?", [
      p.to!,
      p.slug,
      p.id,
    ]);
    db.run("UPDATE subscriptions SET peer_stable_id = ? WHERE id = ?", [p.to!, p.id]);
  }
  for (const p of drop) {
    db.run("DELETE FROM subscriptions WHERE id = ?", [p.id]);
  }
})();

const after = db.query("SELECT count(*) AS c FROM subscriptions").get() as { c: number };
console.log(`rows after: ${after.c} (remapped ${remap.length}, dropped ${drop.length})`);
