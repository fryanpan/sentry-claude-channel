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

// ── Board routes ────────────────────────────────────────────────────────────
//
// A board route files a task on a claude-workspaces board for each new issue in
// a project, so an error reaches a board even when no session is running.
// Routes live only in this local database, never in the repository.

db.run(`
  CREATE TABLE IF NOT EXISTS board_routes (
    project_slug TEXT PRIMARY KEY,
    server_url TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    goal TEXT,
    min_level TEXT NOT NULL DEFAULT 'error',
    created_at TEXT NOT NULL
  )
`);

// Which board task each Sentry issue was filed as, so a repeat comments on
// that task instead of filing a second one.
db.run(`
  CREATE TABLE IF NOT EXISTS filed_issues (
    issue_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (issue_id, workspace_id)
  )
`);

export interface BoardRoute {
  project_slug: string;
  server_url: string;
  workspace_id: string;
  goal: string | null;
  min_level: SentryLevel;
  created_at: string;
}

const upsertRouteStmt = db.prepare(`
  INSERT INTO board_routes (project_slug, server_url, workspace_id, goal, min_level, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(project_slug) DO UPDATE SET
    server_url = excluded.server_url,
    workspace_id = excluded.workspace_id,
    goal = excluded.goal,
    min_level = excluded.min_level
`);
const deleteRouteStmt = db.prepare(`DELETE FROM board_routes WHERE project_slug = ?`);
const getRouteStmt = db.prepare(`SELECT * FROM board_routes WHERE project_slug = ?`);
const listRoutesStmt = db.prepare(`SELECT * FROM board_routes ORDER BY project_slug`);
const putFiledStmt = db.prepare(`
  INSERT INTO filed_issues (issue_id, workspace_id, task_id, created_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(issue_id, workspace_id) DO UPDATE SET task_id = excluded.task_id
`);

export function setBoardRoute(route: Omit<BoardRoute, "created_at">): void {
  upsertRouteStmt.run(
    route.project_slug,
    route.server_url,
    route.workspace_id,
    route.goal,
    route.min_level,
    new Date().toISOString(),
  );
}

export function removeBoardRoute(projectSlug: string): boolean {
  return (deleteRouteStmt.run(projectSlug).changes ?? 0) > 0;
}

export function getBoardRoute(projectSlug: string): BoardRoute | null {
  return (getRouteStmt.get(projectSlug) as BoardRoute | null) ?? null;
}

export function listBoardRoutes(): BoardRoute[] {
  return listRoutesStmt.all() as BoardRoute[];
}

export function recordFiledTask(issueId: string, workspaceId: string, taskId: string): void {
  putFiledStmt.run(issueId, workspaceId, taskId, new Date().toISOString());
}

// ── Claims and retries for board filing ─────────────────────────────────────
//
// A filed_issues row whose task_id is CLAIM_PENDING marks a create in flight.
// One older than CLAIM_TTL_MS is from a receiver that died mid-create and is
// ignored. CLAIM_UNKNOWN marks a create that was sent but never answered: the
// board may hold the task, so nothing files that issue again.

export const CLAIM_PENDING = "pending";
export const CLAIM_UNKNOWN = "unknown";
const CLAIM_TTL_MS = 10 * 60 * 1000;

const claimStmt = db.prepare(`
  INSERT INTO filed_issues (issue_id, workspace_id, task_id, created_at) VALUES (?, ?, '${CLAIM_PENDING}', ?)
  ON CONFLICT(issue_id, workspace_id) DO UPDATE SET task_id = '${CLAIM_PENDING}', created_at = excluded.created_at
  WHERE filed_issues.task_id = '${CLAIM_PENDING}' AND filed_issues.created_at < ?
`);
const getFiledRowStmt = db.prepare(
  `SELECT task_id, created_at FROM filed_issues WHERE issue_id = ? AND workspace_id = ?`,
);
const forgetStmt = db.prepare(`DELETE FROM filed_issues WHERE issue_id = ? AND workspace_id = ?`);
const releaseStmt = db.prepare(
  `DELETE FROM filed_issues WHERE issue_id = ? AND workspace_id = ? AND task_id = '${CLAIM_PENDING}'`,
);
const countSinceStmt = db.prepare(
  `SELECT COUNT(*) AS n FROM filed_issues WHERE workspace_id = ? AND created_at >= ?`,
);

/**
 * The task an issue was filed as, CLAIM_PENDING while a create is in flight,
 * CLAIM_UNKNOWN if a create went unanswered, or null if it was never filed.
 */
export function filedState(issueId: string, workspaceId: string): string | null {
  const row = getFiledRowStmt.get(issueId, workspaceId) as { task_id: string; created_at: string } | null;
  if (!row) return null;
  if (row.task_id === CLAIM_PENDING && Date.parse(row.created_at) < Date.now() - CLAIM_TTL_MS) return null;
  return row.task_id;
}

/** Claim an issue for a create. False if another live claim or a task holds it. */
export function claimIssue(issueId: string, workspaceId: string): boolean {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS).toISOString();
  return (claimStmt.run(issueId, workspaceId, now.toISOString(), staleBefore).changes ?? 0) > 0;
}

/** Drop a claim whose create certainly saved nothing. */
export function releaseClaim(issueId: string, workspaceId: string): void {
  releaseStmt.run(issueId, workspaceId);
}

/** Mark a create that was sent but never answered. */
export function markUnknown(issueId: string, workspaceId: string): void {
  recordFiledTask(issueId, workspaceId, CLAIM_UNKNOWN);
}

/** Forget an issue's task, e.g. after the task was deleted on the board. */
export function forgetFiledTask(issueId: string, workspaceId: string): void {
  forgetStmt.run(issueId, workspaceId);
}

/** How many issues were filed or claimed on a board since a time (epoch ms). */
export function countFiledSince(workspaceId: string, sinceMs: number): number {
  return (countSinceStmt.get(workspaceId, new Date(sinceMs).toISOString()) as { n: number }).n;
}

db.run(`
  CREATE TABLE IF NOT EXISTS pending_filings (
    issue_id TEXT NOT NULL,
    project_slug TEXT NOT NULL,
    payload TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    next_at INTEGER NOT NULL,
    last_error TEXT,
    PRIMARY KEY (issue_id, project_slug)
  )
`);

export interface PendingFiling {
  issue_id: string;
  project_slug: string;
  payload: string;
  attempts: number;
  next_at: number;
  last_error: string | null;
}

const queueStmt = db.prepare(`
  INSERT INTO pending_filings (issue_id, project_slug, payload, attempts, next_at, last_error)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(issue_id, project_slug) DO UPDATE SET
    payload = excluded.payload, attempts = excluded.attempts,
    next_at = excluded.next_at, last_error = excluded.last_error
`);
const dueStmt = db.prepare(`SELECT * FROM pending_filings WHERE next_at <= ? ORDER BY next_at`);
const dequeueStmt = db.prepare(`DELETE FROM pending_filings WHERE issue_id = ? AND project_slug = ?`);

export function queueFiling(f: PendingFiling): void {
  queueStmt.run(f.issue_id, f.project_slug, f.payload, f.attempts, f.next_at, f.last_error);
}

export function dueFilings(nowMs: number): PendingFiling[] {
  return dueStmt.all(nowMs) as PendingFiling[];
}

export function dequeueFiling(issueId: string, projectSlug: string): void {
  dequeueStmt.run(issueId, projectSlug);
}
