/**
 * A matched subscriber that no live session holds must be reported as an
 * error, not counted as a success.
 *
 * This drives the receiver's real webhook handler against a stub claude-hive
 * broker and reads what it logged. The behaviour under test is the one that
 * hid the bug for a month: the broker accepts /send-message for a stable_id
 * belonging to nobody and answers ok, so the receiver's own log was the only
 * place the failure could ever have surfaced, and it said "matched".
 */

import { afterAll, beforeAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DB_PATH = join(mkdtempSync(join(tmpdir(), "sentry-recv-")), "subs.db");
process.env.SENTRY_CHANNEL_DB = DB_PATH;

let livePeers: Array<{ id: string; stable_id: string; cwd: string; git_root: string | null }> = [];
let sent: Array<{ to_stable_id: string }> = [];
let brokerReachable = true;

const broker = Bun.serve({
  port: 0,
  async fetch(req) {
    if (!brokerReachable) return new Response("down", { status: 500 });
    const url = new URL(req.url);
    if (url.pathname === "/list-peers") return Response.json(livePeers);
    if (url.pathname === "/send-message") {
      // Mirrors the real broker: it accepts an unknown stable_id and says ok.
      sent.push((await req.json()) as { to_stable_id: string });
      return Response.json({ ok: true });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
});
process.env.CLAUDE_HIVE_URL = `http://127.0.0.1:${broker.port}`;

const { handleWebhook, __setPeerIdForTest, classifyMatches } = await import("../receiver.ts");
const { addSubscription } = await import("../shared/db.ts");

const LIVE_ID = "2a6518a92270";
const ORPHAN_ID = "c28fb86aae3f";

beforeAll(() => {
  __setPeerIdForTest("bridge-peer");
  addSubscription(LIVE_ID, "claude-workspaces", "warning");
  addSubscription(ORPHAN_ID, "claude-workspaces", "warning");
  livePeers = [
    { id: "vlsoegvv", stable_id: LIVE_ID, cwd: "/dev/a-project", git_root: "/dev/a-project" },
  ];
});
afterAll(() => broker.stop(true));
afterEach(() => {
  sent = [];
  brokerReachable = true;
});

function webhookRequest(level = "error"): Request {
  return new Request("http://localhost/webhook", {
    method: "POST",
    headers: { "Sentry-Hook-Resource": "issue" },
    body: JSON.stringify({
      action: "created",
      data: {
        issue: {
          id: "1",
          shortId: "CW-1",
          title: "TypeError: nope",
          level,
          culprit: "board.ts",
          permalink: "https://example.invalid/issue/1",
          project: { id: "9", slug: "claude-workspaces", name: "claude-workspaces" },
        },
      },
    }),
  });
}

/** Run the handler and collect the JSON log lines it wrote. */
async function capture(req: Request): Promise<Array<Record<string, unknown>>> {
  const lines: Array<Record<string, unknown>> = [];
  const collect = (...args: unknown[]) => {
    try {
      lines.push(JSON.parse(String(args[0])) as Record<string, unknown>);
    } catch {
      /* not one of ours */
    }
  };
  const [outv, errv] = [console.log, console.error];
  console.log = collect as typeof console.log;
  console.error = collect as typeof console.error;
  try {
    await req.clone().text(); // ensure body is materialised before we swap streams
    await handleWebhook(req);
  } finally {
    console.log = outv;
    console.error = errv;
  }
  return lines;
}

describe("classifyMatches", () => {
  it("separates subscribers a live peer holds from those nobody holds", () => {
    expect(classifyMatches([LIVE_ID, ORPHAN_ID], [LIVE_ID])).toEqual({
      deliverable: [LIVE_ID],
      undeliverable: [ORPHAN_ID],
    });
  });

  it("calls every match undeliverable when no peer is alive", () => {
    expect(classifyMatches([LIVE_ID], []).undeliverable).toEqual([LIVE_ID]);
  });
});

describe("the receiver's webhook handler", () => {
  it("logs an error naming the subscriber no live session holds", async () => {
    const lines = await capture(webhookRequest());
    const bad = lines.filter((l) => l.msg === "undeliverable subscriber — no live claude-hive peer holds this stable_id");
    expect(bad).toHaveLength(1);
    expect(bad[0]!.level).toBe("error");
    expect(bad[0]!.to_stable_id).toBe(ORPHAN_ID);
  });

  it("does not report the live subscriber as undeliverable", async () => {
    const lines = await capture(webhookRequest());
    const ids = lines.filter((l) => l.msg?.toString().startsWith("undeliverable")).map((l) => l.to_stable_id);
    expect(ids).not.toContain(LIVE_ID);
  });

  it("counts deliverable peers separately from matched peers", async () => {
    const lines = await capture(webhookRequest());
    const matched = lines.find((l) => l.msg === "webhook matched")!;
    expect(matched.matched_peers).toBe(2);
    expect(matched.deliverable_peers).toBe(1);
  });

  it("labels the match line at info level, with the issue's own severity kept separate", async () => {
    // `level` used to be spread over the record and overwrite the log level,
    // so every match line in production reads "error".
    const matched = (await capture(webhookRequest("warning"))).find((l) => l.msg === "webhook matched")!;
    expect(matched.level).toBe("info");
    expect(matched.issue_level).toBe("warning");
  });

  it("still queues the message for the orphaned id, so a returning session gets it", async () => {
    await capture(webhookRequest());
    expect(sent.map((s) => s.to_stable_id).sort()).toEqual([ORPHAN_ID, LIVE_ID].sort());
  });

  it("warns instead of claiming everything is fine when the broker cannot be asked", async () => {
    brokerReachable = false;
    const lines = await capture(webhookRequest());
    expect(lines.some((l) => l.level === "warn" && String(l.msg).includes("could not list"))).toBe(true);
  });
});
