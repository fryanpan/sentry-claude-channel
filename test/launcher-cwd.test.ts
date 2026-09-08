/**
 * The launcher must hand the calling session's cwd to the server.
 *
 * Without this the server has no way to tell sessions apart: it cd's to its
 * own install directory before exec'ing bun, so process.cwd() is the same
 * string for every session on the machine.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LAUNCHER = join(import.meta.dir, "..", "bin", "sentry-channel-mcp.sh");
const ENTRYPOINT = join(import.meta.dir, "..", "server.ts");

async function launcherReportsCwd(cwd: string): Promise<string> {
  const proc = Bun.spawn(["/bin/sh", LAUNCHER, ENTRYPOINT], {
    cwd,
    env: { ...process.env, SENTRY_CHANNEL_MCP_PRINT_SESSION_CWD: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return out.trim();
}

describe("the MCP launcher", () => {
  it("passes the directory it was spawned in, not the plugin's own", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sentry-launch-")));
    expect(await launcherReportsCwd(dir)).toBe(dir);
  });

  it("reports two different callers differently", async () => {
    const a = realpathSync(mkdtempSync(join(tmpdir(), "sentry-launch-a-")));
    const b = realpathSync(mkdtempSync(join(tmpdir(), "sentry-launch-b-")));
    expect(await launcherReportsCwd(a)).not.toBe(await launcherReportsCwd(b));
  });

  it("resolves a symlinked workspace to its physical path", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sentry-launch-link-")));
    const real = join(root, "project");
    mkdirSync(real);
    const alias = join(root, "alias");
    symlinkSync(real, alias);
    expect(await launcherReportsCwd(alias)).toBe(real);
  });
});
