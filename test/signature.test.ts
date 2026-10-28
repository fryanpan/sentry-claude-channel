/**
 * The receiver must reject any webhook it cannot verify, including when no
 * SENTRY_CLIENT_SECRET is set. It used to skip the check in that case, so
 * anyone who found the public URL could post fake alerts.
 */

import { afterEach, describe, expect, it } from "bun:test";

const { handleWebhook } = await import("../receiver.ts");

const SECRET = "test-client-secret";
const BODY = JSON.stringify({ action: "created", data: {} });

async function sign(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function request(signature?: string): Request {
  const headers: Record<string, string> = { "Sentry-Hook-Resource": "installation" };
  if (signature) headers["Sentry-Hook-Signature"] = signature;
  return new Request("http://localhost/webhook", { method: "POST", headers, body: BODY });
}

const original = process.env.SENTRY_CLIENT_SECRET;
afterEach(() => {
  if (original === undefined) delete process.env.SENTRY_CLIENT_SECRET;
  else process.env.SENTRY_CLIENT_SECRET = original;
});

describe("webhook signature check", () => {
  it("rejects an unsigned request when no secret is set", async () => {
    delete process.env.SENTRY_CLIENT_SECRET;
    expect((await handleWebhook(request())).status).toBe(403);
  });

  it("rejects a request when the secret is set but empty", async () => {
    process.env.SENTRY_CLIENT_SECRET = "";
    expect((await handleWebhook(request())).status).toBe(403);
  });

  it("rejects an unsigned request when a secret is set", async () => {
    process.env.SENTRY_CLIENT_SECRET = SECRET;
    expect((await handleWebhook(request())).status).toBe(403);
  });

  it("rejects a request signed with the wrong secret", async () => {
    process.env.SENTRY_CLIENT_SECRET = SECRET;
    expect((await handleWebhook(request(await sign(BODY, "wrong")))).status).toBe(403);
  });

  it("rejects a request when the secret is only whitespace", async () => {
    process.env.SENTRY_CLIENT_SECRET = "  ";
    expect((await handleWebhook(request(await sign(BODY, "  ")))).status).toBe(403);
  });

  it("accepts a correctly signed request", async () => {
    process.env.SENTRY_CLIENT_SECRET = SECRET;
    expect((await handleWebhook(request(await sign(BODY, SECRET)))).status).toBe(200);
  });
});
