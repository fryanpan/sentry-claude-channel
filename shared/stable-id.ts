/**
 * Compute a workspace-scoped stable identifier for a peer.
 *
 * Mirrors claude-hive's stable_id scheme — first 12 hex chars of
 * sha256(git_root || cwd) — so a subscription recorded here is
 * addressable by the same ID claude-hive derives for the same
 * Claude Code session. This means the receiver daemon can call
 * claude-hive's /send-message with to_stable_id and have it land
 * in the right peer without an extra ID-translation step.
 *
 * The hash formula itself is a simple, non-copyrightable convention
 * (SHA-256 the workspace path, truncate to 12 hex chars). This file
 * is original code; no code copied from claude-hive-mcp.
 */

import { execFileSync } from "node:child_process";

export function computeStableId(cwd: string): string {
  const root = findGitRoot(cwd) ?? cwd;
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(root);
  return hasher.digest("hex").slice(0, 12);
}

function findGitRoot(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}
