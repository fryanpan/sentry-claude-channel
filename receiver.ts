/**
 * Sentry webhook receiver daemon.
 *
 * One process per machine. Listens on $RECEIVER_PORT for Sentry's webhook
 * POSTs, verifies the signature, looks up subscribed peers by project slug
 * and severity threshold, and forwards each match to claude-hive's
 * /send-message as a formatted text payload.
 *
 * Sentry webhook docs: https://docs.sentry.io/organization/integrations/integration-platform/webhooks/
 *
 * Deployed behind a tunnel that gives Sentry a public HTTPS URL for /webhook
 * (see SETUP.md).
 */

import { dequeueFiling, dueFilings, findMatchingPeers, getBoardRoute, listBoardRoutes, queueFiling, staleClaims } from "./shared/db.ts";
import { fileIssueOnBoard, refreshBoardToken, type BoardDeps } from "./shared/board.ts";
import type { BoardRoute } from "./shared/db.ts";
import { sendMessage, registerPeer, heartbeat, listPeers } from "./shared/hive.ts";
import type { SentryIssueWebhook, SentryLevel } from "./shared/types.ts";

const PORT = parseInt(process.env.SENTRY_RECEIVER_PORT ?? "7903", 10);
const RECEIVER_STABLE_ID = "sentry-bridge"; // fixed identifier in claude-hive
const RECEIVER_PEER_ID_FILE = `${process.env.HOME ?? ""}/.sentry-channel-peer-id`;

let myPeerId: string | null = null;

function log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const line = JSON.stringify({ ts, level, msg, ...(extra ?? {}) });
  if (level === "error") console.error(line);
  else console.log(line);
}

/** The Sentry Client Secret, or "" when unset or only whitespace. */
function clientSecret(): string {
  return (process.env.SENTRY_CLIENT_SECRET ?? "").trim();
}

/**
 * Verify Sentry's webhook signature.
 *
 * Sentry signs the raw request body with HMAC-SHA256 using the integration's
 * Client Secret. Header: `Sentry-Hook-Signature`. We compare in constant time.
 *
 * Fails closed: with no secret set, no request can be verified, so every
 * request is rejected. main() logs that once at startup.
 *
 * Docs: https://docs.sentry.io/organization/integrations/integration-platform/webhooks/#verifying-the-signature
 */
async function verifySignature(rawBody: string, signature: string | null): Promise<boolean> {
  const secret = clientSecret();
  if (!secret || !signature) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time compare
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

function formatIssueMessage(payload: SentryIssueWebhook): string {
  const { action, data } = payload;
  const issue = data.issue;
  const culprit = issue.culprit ? `\n**Culprit:** \`${issue.culprit}\`` : "";
  const meta = issue.metadata?.value ? `\n**Detail:** ${issue.metadata.value.slice(0, 200)}` : "";
  const counts =
    issue.count || issue.userCount
      ? `\n**Events:** ${issue.count ?? "?"} · **Users:** ${issue.userCount ?? 0}`
      : "";

  return [
    `🛑 **Sentry: ${action}** — ${issue.shortId}`,
    ``,
    `**Project:** ${issue.project.slug} (${issue.project.name})`,
    `**Level:** ${issue.level}`,
    `**Title:** ${issue.title}${culprit}${meta}${counts}`,
    ``,
    `**Link:** ${issue.permalink}`,
  ].join("\n");
}

/**
 * Split matched subscribers into those a live session can actually receive,
 * and those addressed to an id no session holds.
 *
 * This exists because every other signal lies. claude-hive's /send-message
 * inserts the row and returns ok for an unknown stable_id, and a message's
 * `delivered` flag stays 0 until the recipient acks it — so a live peer that
 * has not polled yet is indistinguishable from a peer that does not exist.
 * The broker's live peer list is the one thing that separates them.
 */
export function classifyMatches(
  matches: readonly string[],
  livePeerStableIds: readonly string[],
): { deliverable: string[]; undeliverable: string[] } {
  const live = new Set(livePeerStableIds);
  const deliverable: string[] = [];
  const undeliverable: string[] = [];
  for (const id of matches) {
    (live.has(id) ? deliverable : undeliverable).push(id);
  }
  return { deliverable, undeliverable };
}

export async function handleWebhook(req: Request): Promise<Response> {
  const rawBody = await req.text();
  const signature = req.headers.get("Sentry-Hook-Signature");
  const resourceType = req.headers.get("Sentry-Hook-Resource"); // "issue" | "event_alert" | "metric_alert" | etc.

  if (!(await verifySignature(rawBody, signature))) {
    log("warn", "signature verification failed", { resourceType });
    return new Response("forbidden", { status: 403 });
  }

  // Only handle issue events for now. Extend later for event_alert / metric_alert.
  if (resourceType !== "issue") {
    log("info", "ignored non-issue resource", { resourceType });
    return new Response("ok", { status: 200 });
  }

  let payload: SentryIssueWebhook;
  try {
    payload = JSON.parse(rawBody) as SentryIssueWebhook;
  } catch (err) {
    log("error", "invalid JSON payload", { err: String(err) });
    return new Response("bad request", { status: 400 });
  }

  const issue = payload.data?.issue;
  if (!issue?.project?.slug || !issue?.level) {
    log("warn", "payload missing project.slug or level", { action: payload.action });
    return new Response("ok", { status: 200 });
  }

  // Match subscribers. Note `issue_level`, not `level`: the extra fields are
  // spread over the log record, so a key called `level` overwrote the log
  // level itself and every match line came out labelled "error".
  const matches = findMatchingPeers(issue.project.slug, issue.level as SentryLevel);

  let livePeerIds: string[] | null = null;
  try {
    livePeerIds = (await listPeers()).map((p) => p.stable_id);
  } catch (err) {
    log("warn", "could not list claude-hive peers — cannot tell deliverable from not", {
      err: String(err),
    });
  }
  const { deliverable, undeliverable } =
    livePeerIds === null
      ? { deliverable: [...matches], undeliverable: [] as string[] }
      : classifyMatches(matches, livePeerIds);

  log("info", "webhook matched", {
    action: payload.action,
    project: issue.project.slug,
    issue_level: issue.level,
    matched_peers: matches.length,
    deliverable_peers: deliverable.length,
  });

  // An undeliverable match is a broken subscription, not a quiet no-op. The
  // message is still queued (a session that comes back with the same id will
  // get it), but it is reported as an error so a misfiled row is visible.
  for (const to_stable_id of undeliverable) {
    log("error", "undeliverable subscriber — no live claude-hive peer holds this stable_id", {
      to_stable_id,
      project: issue.project.slug,
      hint: "the subscription is misfiled or its session is gone; re-run sentry_watch_project from the session that wants these events",
    });
  }

  // File on the project's board, if it has one. This runs whether or not any
  // session is subscribed or alive, which is the point of it.
  // Not awaited: Sentry wants a quick ack, and a slow board must not delay it.
  const route = getBoardRoute(issue.project.slug);
  if (route) {
    const filing = fileAndLog(route, payload, 0).finally(() => inFlight.delete(filing));
    inFlight.add(filing);
  }

  if (matches.length === 0 || !myPeerId) {
    return new Response("ok", { status: 200 });
  }

  const text = formatIssueMessage(payload);

  // Fan out — fire-and-forget per peer; failures shouldn't block ack to Sentry.
  await Promise.allSettled(
    matches.map((to_stable_id) =>
      sendMessage({ from_id: myPeerId!, to_stable_id, text }).catch((err) =>
        log("error", "send_message failed", { to_stable_id, err: String(err) }),
      ),
    ),
  );

  return new Response("ok", { status: 200 });
}

async function ensureRegistered(): Promise<void> {
  // Reuse stable peer-id across daemon restarts so claude-hive can address us.
  try {
    const existing = await Bun.file(RECEIVER_PEER_ID_FILE).text();
    myPeerId = existing.trim() || null;
  } catch {
    // No prior file — first run.
  }

  const reg = await registerPeer({
    pid: process.pid,
    cwd: process.cwd(),
    git_root: null,
    summary: "Sentry webhook bridge — routes Sentry issue events to subscribed peers.",
    stable_id: RECEIVER_STABLE_ID,
  });
  myPeerId = reg.id;
  await Bun.write(RECEIVER_PEER_ID_FILE, myPeerId);
  log("info", "registered with claude-hive", { id: myPeerId, stable_id: reg.stable_id });
}

async function startHeartbeat(): Promise<void> {
  setInterval(async () => {
    if (!myPeerId) return;
    try {
      await heartbeat(myPeerId);
    } catch (err) {
      log("warn", "heartbeat failed", { err: String(err) });
    }
  }, 30_000);
}

let boardDeps: BoardDeps | undefined;
const inFlight = new Set<Promise<void>>();

/** Test seam: settles when every board filing in flight has finished. */
export async function __lastBoardFilingForTest(): Promise<void> {
  await Promise.all([...inFlight]);
}

/** Test seam: replace the HTTP client and Keychain reader used for board filing. */
export function __setBoardDepsForTest(deps: BoardDeps | undefined): void {
  boardDeps = deps;
}

/** Test seam: the receiver must have a hive peer id before it can fan out. */
export function __setPeerIdForTest(id: string | null): void {
  myPeerId = id;
}

/** The fields a queued filing needs, trimmed, so a huge webhook body isn't stored. */
export function slimPayload(payload: SentryIssueWebhook): SentryIssueWebhook {
  const i = payload.data.issue;
  const cut = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
  return {
    action: payload.action,
    data: {
      issue: {
        id: cut(i.id, 64),
        shortId: cut(i.shortId, 64),
        title: cut(i.title, 500),
        level: i.level,
        culprit: cut(i.culprit, 300),
        permalink: cut(i.permalink, 500),
        project: { id: cut(i.project.id, 64), slug: cut(i.project.slug, 100), name: cut(i.project.name, 100) },
        ...(i.metadata?.value ? { metadata: { value: cut(i.metadata.value, 500) } } : {}),
        ...(i.count !== undefined ? { count: cut(String(i.count), 20) } : {}),
        ...(typeof i.userCount === "number" ? { userCount: i.userCount } : {}),
      },
    },
  };
}

/** Log every claim left by a receiver that stopped mid-create, so a person checks the board. */
export function logStaleClaims(): void {
  for (const c of staleClaims()) {
    log("error", "board filing cut off by a restart: check the board for this issue, then clear it (see README)", {
      issue_id: c.issue_id,
      claimed_at: c.created_at,
    });
  }
}

/** Retries give up after this many attempts (about two days at the backoff below). */
export const MAX_FILING_ATTEMPTS = 16;

/** Minutes until retry number `attempt`: 1, 2, 4, ... capped at 6 hours. */
export function retryDelayMs(attempt: number): number {
  return Math.min(2 ** attempt, 360) * 60_000;
}

/**
 * File one webhook on its board and log the result. A filing that certainly
 * saved nothing is queued in the database and retried; nothing here throws.
 */
async function fileAndLog(route: BoardRoute, payload: SentryIssueWebhook, attempts: number): Promise<void> {
  const issue = payload.data.issue;
  try {
    const result = await fileIssueOnBoard(route, payload, boardDeps);
    const fields = {
      project: issue.project.slug,
      issue: issue.shortId,
      ...(attempts > 0 ? { attempt: attempts + 1 } : {}),
      ...("taskId" in result ? { task_id: result.taskId } : {}),
      ...("reason" in result ? { reason: result.reason } : {}),
      ...("error" in result ? { err: result.error } : {}),
    };
    // A queued filing that meets another filing's claim waits its turn again;
    // a fresh webhook that does is a duplicate delivery and is dropped.
    const requeue = result.kind === "retry" || (result.kind === "skipped" && result.inProgress === true && attempts > 0);
    if (requeue) {
      if (attempts + 1 >= MAX_FILING_ATTEMPTS) {
        dequeueFiling(issue.id, issue.project.slug);
        log("error", "board filing given up after repeated failures", fields);
        return;
      }
      const queued = queueFiling({
        issue_id: issue.id,
        project_slug: issue.project.slug,
        payload: JSON.stringify(slimPayload(payload)),
        attempts: attempts + 1,
        next_at: Date.now() + retryDelayMs(attempts),
        last_error: "error" in result ? result.error : result.reason,
      });
      if (queued) log("warn", "board filing queued for retry", fields);
      else log("error", "board filing dropped: this project's retry queue is full", fields);
      return;
    }
    // A fresh webhook that is skipped (another action, a lower level) says
    // nothing about a filing already queued for this issue, so it leaves the
    // queue alone. Only an outcome for the queued filing itself removes it.
    if (result.kind !== "skipped" || attempts > 0) dequeueFiling(issue.id, issue.project.slug);
    log(result.kind === "failed" ? "error" : "info", `board ${result.kind}`, fields);
  } catch (err) {
    log("error", "board filing threw", { project: issue.project.slug, issue: issue.shortId, err: String(err) });
  }
}

let retrying = false;

/** Retry every queued filing that is due. Runs every minute; a run still going skips the next. */
export async function retryDueFilings(nowMs = Date.now()): Promise<void> {
  if (retrying) return;
  retrying = true;
  try {
    await retryDue(nowMs);
  } finally {
    retrying = false;
  }
}

async function retryDue(nowMs: number): Promise<void> {
  for (const f of dueFilings(nowMs)) {
    const route = getBoardRoute(f.project_slug);
    if (!route) {
      dequeueFiling(f.issue_id, f.project_slug);
      continue;
    }
    let payload: SentryIssueWebhook;
    try {
      payload = JSON.parse(f.payload) as SentryIssueWebhook;
    } catch {
      dequeueFiling(f.issue_id, f.project_slug);
      continue;
    }
    await fileAndLog(route, payload, f.attempts);
  }
}

/** Refresh every routed board's token: at startup, then once a day. */
async function refreshAllBoardTokens(): Promise<void> {
  for (const route of listBoardRoutes()) {
    const result = await refreshBoardToken(route, boardDeps); // never throws
    log(result.kind === "failed" ? "error" : "info", `board token ${result.kind}`, {
      project: route.project_slug,
      ...(result.kind === "failed" ? { err: result.error } : { expires_at: result.expiresAt }),
    });
  }
}

async function main() {
  if (!clientSecret()) {
    log("error", "SENTRY_CLIENT_SECRET is not set — every webhook will be rejected with 403 until it is set and the receiver restarts");
  }
  await ensureRegistered();
  await startHeartbeat();

  // The server starts before any board work, so a slow board or a locked
  // Keychain can never keep the port closed.
  Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/health") {
        return new Response("ok", { status: 200 });
      }
      if (req.method === "POST" && url.pathname === "/webhook") {
        return handleWebhook(req);
      }
      return new Response("not found", { status: 404 });
    },
  });

  log("info", `sentry-claude-channel receiver listening on :${PORT}`);

  const boardWork = (name: string, fn: () => Promise<void>) => () =>
    void fn().catch((err) => log("error", `${name} threw`, { err: String(err) }));
  logStaleClaims();
  boardWork("board token refresh", refreshAllBoardTokens)();
  setInterval(boardWork("board token refresh", refreshAllBoardTokens), 24 * 60 * 60 * 1000);
  setInterval(boardWork("board filing retry", retryDueFilings), 60_000);
}

// Guarded so the module can be imported by tests without binding a port or
// registering a second bridge peer with claude-hive.
if (import.meta.main) {
  main().catch((err) => {
    log("error", "receiver failed to start", { err: String(err) });
    process.exit(1);
  });
}
