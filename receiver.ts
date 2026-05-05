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
 * Bryan deploys this behind a Cloudflare tunnel at sentry-bridge.fryanpan.com
 * (mirrors notion-bridge.fryanpan.com pattern).
 */

import { findMatchingPeers } from "./shared/db.ts";
import { sendMessage, registerPeer, heartbeat } from "./shared/hive.ts";
import type { SentryIssueWebhook, SentryLevel } from "./shared/types.ts";

const PORT = parseInt(process.env.SENTRY_RECEIVER_PORT ?? "7903", 10);
const SENTRY_CLIENT_SECRET = process.env.SENTRY_CLIENT_SECRET ?? "";
const RECEIVER_STABLE_ID = "sentry-bridge"; // fixed identifier in claude-hive
const RECEIVER_PEER_ID_FILE = `${process.env.HOME ?? ""}/.sentry-channel-peer-id`;

let myPeerId: string | null = null;

function log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const line = JSON.stringify({ ts, level, msg, ...(extra ?? {}) });
  if (level === "error") console.error(line);
  else console.log(line);
}

/**
 * Verify Sentry's webhook signature.
 *
 * Sentry signs the raw request body with HMAC-SHA256 using the integration's
 * Client Secret. Header: `Sentry-Hook-Signature`. We compare in constant time.
 *
 * Docs: https://docs.sentry.io/organization/integrations/integration-platform/webhooks/#verifying-the-signature
 */
async function verifySignature(rawBody: string, signature: string | null): Promise<boolean> {
  if (!SENTRY_CLIENT_SECRET) {
    log("warn", "SENTRY_CLIENT_SECRET not set — skipping signature verification (dev mode)");
    return true;
  }
  if (!signature) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(SENTRY_CLIENT_SECRET),
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

async function handleWebhook(req: Request): Promise<Response> {
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

  // Match subscribers
  const matches = findMatchingPeers(issue.project.slug, issue.level as SentryLevel);
  log("info", "webhook matched", {
    action: payload.action,
    project: issue.project.slug,
    level: issue.level,
    matched_peers: matches.length,
  });

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

async function main() {
  await ensureRegistered();
  await startHeartbeat();

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
}

main().catch((err) => {
  log("error", "receiver failed to start", { err: String(err) });
  process.exit(1);
});
