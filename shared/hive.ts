/**
 * Thin HTTP client for the claude-hive broker.
 *
 * The receiver is a long-running daemon (not a Claude Code session) and
 * needs to register once on startup, heartbeat, and push events as they
 * arrive. We talk to claude-hive's HTTP API directly rather than going
 * through an MCP client. Wire format matches claude-hive's documented
 * request/response types — written from scratch against the observable
 * protocol; no code copied from claude-hive-mcp.
 */

import type { StableId } from "./types.ts";

const HIVE_URL = process.env.CLAUDE_HIVE_URL ?? "http://127.0.0.1:7900";
const HEALTH_TIMEOUT_MS = 2000;

interface RegisterResponse {
  id: string;
  stable_id: string;
  reclaimed?: boolean;
  cached_summary?: string | null;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${HIVE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `claude-hive ${path} ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  return (await res.json()) as T;
}

export async function registerPeer(opts: {
  pid: number;
  cwd: string;
  git_root: string | null;
  summary: string;
  stable_id: string;
}): Promise<RegisterResponse> {
  return postJson<RegisterResponse>("/register", {
    pid: opts.pid,
    cwd: opts.cwd,
    git_root: opts.git_root,
    tty: null,
    summary: opts.summary,
    stable_id: opts.stable_id,
  });
}

export async function sendMessage(opts: {
  from_id: string;
  to_stable_id: StableId;
  text: string;
}): Promise<void> {
  await postJson("/send-message", {
    from_id: opts.from_id,
    to_stable_id: opts.to_stable_id,
    text: opts.text,
  });
}

export async function heartbeat(id: string): Promise<void> {
  await postJson("/heartbeat", { id });
}

export async function unregister(id: string): Promise<void> {
  await postJson("/unregister", { id });
}

export async function isHiveAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${HIVE_URL}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
