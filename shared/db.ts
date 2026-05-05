/**
 * SQLite-backed subscription store.
 *
 * Both the receiver daemon and the per-session MCP server open the same
 * database file in WAL mode. Safe concurrent access: multiple readers +
 * one writer at a time, plenty for the expected volume (Sentry events
 * land at <1/sec under normal conditions).
 */

import { Database } from "bun:sqlite";
import type { Subscription, SentryLevel } from "./types.ts";
import { LEVEL_RANK } from "./types.ts";

const DB_PATH =
  process.env.SENTRY_CHANNEL_DB ??
  `${process.env.HOME ?? ""}/.sentry-channel.db`;

export const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    peer_stable_id TEXT NOT NULL,
    project_slug TEXT NOT NULL,
    min_level TEXT NOT NULL DEFAULT 'warning',
    created_at TEXT NOT NULL,
    UNIQUE(peer_stable_id, project_slug)
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_project ON subscriptions(project_slug)`);

const upsertStmt = db.prepare(`
  INSERT INTO subscriptions (peer_stable_id, project_slug, min_level, created_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(peer_stable_id, project_slug) DO UPDATE SET
    min_level = excluded.min_level
`);
const deleteStmt = db.prepare(`
  DELETE FROM subscriptions WHERE peer_stable_id = ? AND project_slug = ?
`);
const listByPeerStmt = db.prepare(`
  SELECT id, peer_stable_id, project_slug, min_level, created_at
  FROM subscriptions WHERE peer_stable_id = ?
  ORDER BY created_at ASC
`);
const matchByProjectStmt = db.prepare(`
  SELECT peer_stable_id, min_level FROM subscriptions WHERE project_slug = ?
`);

export function addSubscription(
  peerStableId: string,
  projectSlug: string,
  minLevel: SentryLevel,
): void {
  upsertStmt.run(
    peerStableId,
    projectSlug,
    minLevel,
    new Date().toISOString(),
  );
}

export function removeSubscription(
  peerStableId: string,
  projectSlug: string,
): boolean {
  const res = deleteStmt.run(peerStableId, projectSlug);
  return (res.changes ?? 0) > 0;
}

export function listSubscriptionsFor(peerStableId: string): Subscription[] {
  const rows = listByPeerStmt.all(peerStableId) as Array<{
    id: number;
    peer_stable_id: string;
    project_slug: string;
    min_level: SentryLevel;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    peer_stable_id: r.peer_stable_id,
    project_slug: r.project_slug,
    min_level: r.min_level,
    created_at: r.created_at,
  }));
}

/**
 * Given a project slug and an event level, return all peer stable_ids
 * that should receive a notification. A subscriber receives the event
 * if the event's level is >= their min_level threshold.
 */
export function findMatchingPeers(
  projectSlug: string,
  level: SentryLevel,
): string[] {
  const eventRank = LEVEL_RANK[level];
  const rows = matchByProjectStmt.all(projectSlug) as Array<{
    peer_stable_id: string;
    min_level: SentryLevel;
  }>;
  return rows
    .filter((r) => LEVEL_RANK[r.min_level] <= eventRank)
    .map((r) => r.peer_stable_id);
}
