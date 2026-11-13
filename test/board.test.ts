/**
 * Board filing: a new Sentry issue becomes one board task, a repeat becomes a
 * comment on that task, and a board token is only ever sent to this machine.
 *
 * Drives the receiver's real webhook handler against a stub board server.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SENTRY_CHANNEL_DB = join(mkdtempSync(join(tmpdir(), "sentry-board-")), "subs.db");
process.env.SENTRY_CLIENT_SECRET = "test-client-secret";

// No claude-hive broker is reachable and no session subscribes: board filing
// must still happen.
process.env.CLAUDE_HIVE_URL = "http://127.0.0.1:9";

type Call = { path: string; auth: string | null; body: Record<string, unknown> };
let calls: Call[] = [];
let nextTask = 1;

const board = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    calls.push({ path: url.pathname, auth: req.headers.get("authorization"), body: (await req.json()) as Record<string, unknown> });
    if (url.pathname.endsWith("/tasks")) return Response.json({ task: { id: `t-${nextTask++}` } });
    return Response.json({ ok: true });
  },
});

const { handleWebhook, __setBoardDepsForTest, __lastBoardFilingForTest } = await import("../receiver.ts");
const { setBoardRoute, removeBoardRoute } = await import("../shared/db.ts");
const { isLoopbackUrl, refreshBoardToken } = await import("../shared/board.ts");

const BOARD = "w-test";
const SERVER = `http://127.0.0.1:${board.port}`;
let token: string | null = "at2.tok.agent.w-test.0.mac";

beforeAll(() => {
  __setBoardDepsForTest({ fetch, readToken: async () => token });
});
afterAll(() => board.stop(true));
afterEach(() => {
  calls = [];
  token = "at2.tok.agent.w-test.0.mac";
  setBoardRoute({ project_slug: "site", server_url: SERVER, workspace_id: BOARD, goal: null, min_level: "error" });
});

async function send(issueId: string, opts: { action?: string; level?: string; project?: string } = {}) {
  const body = JSON.stringify({
    action: opts.action ?? "created",
    data: {
      issue: {
        id: issueId,
        shortId: `SITE-${issueId}`,
        title: "TypeError: nope",
        level: opts.level ?? "error",
        culprit: "page.ts",
        permalink: `https://example.invalid/issues/${issueId}`,
        project: { id: "9", slug: opts.project ?? "site", name: "site" },
        count: "3",
        userCount: 1,
      },
    },
  });
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode("test-client-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body))))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const res = await handleWebhook(
    new Request("http://localhost/webhook", {
      method: "POST",
      headers: { "Sentry-Hook-Resource": "issue", "Sentry-Hook-Signature": sig },
      body,
    }),
  );
  await __lastBoardFilingForTest();
  return res;
}

setBoardRoute({ project_slug: "site", server_url: SERVER, workspace_id: BOARD, goal: null, min_level: "error" });

describe("filing on a board", () => {
  it("files one task for a new issue, with the board token and the Sentry link", async () => {
    const res = await send("100");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(`/api/workspaces/${BOARD}/tasks`);
    expect(calls[0]!.auth).toBe("Bearer at2.tok.agent.w-test.0.mac");
    expect(String(calls[0]!.body.title)).toContain("SITE-100");
    expect(calls[0]!.body.links).toEqual([{ kind: "url", url: "https://example.invalid/issues/100" }]);
  });

  it("comments on the existing task when the same issue comes again, instead of filing a second", async () => {
    await send("200");
    const taskId = `t-${nextTask - 1}`;
    calls = [];
    await send("200", { action: "unresolved" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(`/api/workspaces/${BOARD}/docs/task:${taskId}/threads`);
    expect(String(calls[0]!.body.text)).toContain("unresolved");
    expect(calls[0]!.body.anchor).toEqual({ kind: "subject" });
    expect(calls[0]!.body.requestId).toBe("sentry-200-unresolved-3");
  });

  it("files nothing below the route's level", async () => {
    await send("300", { level: "warning" });
    expect(calls).toHaveLength(0);
  });

  it("files nothing for a resolved issue", async () => {
    await send("400", { action: "resolved" });
    expect(calls).toHaveLength(0);
  });

  it("files nothing for a project with no route", async () => {
    await send("500", { project: "other" });
    expect(calls).toHaveLength(0);
  });

  it("sends nothing when the board has no token in the Keychain", async () => {
    token = null;
    await send("600");
    expect(calls).toHaveLength(0);
  });

  it("never sends a token to a route that is not on this machine", async () => {
    removeBoardRoute("site");
    setBoardRoute({ project_slug: "site", server_url: "https://attacker.example", workspace_id: BOARD, goal: null, min_level: "error" });
    let fetched = false;
    __setBoardDepsForTest({ fetch: (async () => { fetched = true; return new Response("{}"); }) as unknown as typeof fetch, readToken: async () => token });
    await send("700");
    expect(fetched).toBe(false);
    __setBoardDepsForTest({ fetch, readToken: async () => token });
  });
});

describe("refreshing a board token", () => {
  it("swaps the token for the fresh one the board returns", async () => {
    let written = "";
    const stub = (async (url: string, init: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:1/api/board-tokens/refresh");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer at2.old");
      return Response.json({ ok: true, token: "at2.new", expiresAt: 123 });
    }) as unknown as typeof fetch;
    const route = { project_slug: "site", server_url: "http://127.0.0.1:1", workspace_id: BOARD, goal: null, min_level: "error" as const, created_at: "" };
    const result = await refreshBoardToken(route, {
      fetch: stub,
      readToken: async () => "at2.old",
      writeToken: async (_ws, t) => { written = t; return true; },
    });
    expect(result).toEqual({ kind: "refreshed", expiresAt: 123 });
    expect(written).toBe("at2.new");
  });

  it("keeps the old token and reports failure when the board refuses", async () => {
    let wrote = false;
    const route = { project_slug: "site", server_url: "http://127.0.0.1:1", workspace_id: BOARD, goal: null, min_level: "error" as const, created_at: "" };
    const result = await refreshBoardToken(route, {
      fetch: (async () => new Response("expired", { status: 401 })) as unknown as typeof fetch,
      readToken: async () => "at2.old",
      writeToken: async () => { wrote = true; return true; },
    });
    expect(result.kind).toBe("failed");
    expect(wrote).toBe(false);
  });
});

describe("isLoopbackUrl", () => {
  it("accepts this machine and refuses everything else", () => {
    expect(isLoopbackUrl("http://127.0.0.1:8788")).toBe(true);
    expect(isLoopbackUrl("http://localhost:8788/")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:8788")).toBe(true);
    expect(isLoopbackUrl("https://example.com")).toBe(false);
    expect(isLoopbackUrl("http://127.0.0.1.example.com")).toBe(false);
    expect(isLoopbackUrl("http://user:pw@127.0.0.1")).toBe(false);
    expect(isLoopbackUrl("file:///etc/passwd")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});
