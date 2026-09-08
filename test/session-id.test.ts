/**
 * The subscriber id a watch is filed under.
 *
 * The bug these cover: the id came from process.cwd(), which under this
 * plugin's launcher is the plugin's install directory rather than the calling
 * session's workspace. Every assertion here is about which SESSION a
 * subscription ends up addressed to, and about refusing to answer rather than
 * answering wrongly.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveSubscriberId,
  sessionCwd,
  peersAtCwd,
  SESSION_CWD_ENV,
  type HivePeer,
} from "../shared/session-id.ts";

function peer(stable_id: string, cwd: string, git_root: string | null = null): HivePeer {
  return { id: `id-${stable_id}`, stable_id, cwd, git_root };
}

const WORKSPACE = "/Volumes/Data/Users/someone/dev/a-project";
const SESSION = peer("2a6518a92270", WORKSPACE, WORKSPACE);
const OTHER = peer("644c27b083a3", "/Volumes/Data/Users/someone/dev/other", null);
const PLUGIN_DIR = "/Users/someone/.claude/plugins/cache/sentry-claude-channel/0.3.0";

describe("sessionCwd", () => {
  it("reads the cwd the launcher captured", () => {
    expect(sessionCwd({ [SESSION_CWD_ENV]: WORKSPACE })).toBe(WORKSPACE);
  });

  it("is null when the launcher passed nothing, so the caller must refuse", () => {
    expect(sessionCwd({})).toBeNull();
    expect(sessionCwd({ [SESSION_CWD_ENV]: "" })).toBeNull();
  });

  it("is null for a relative path, which cannot identify a workspace", () => {
    expect(sessionCwd({ [SESSION_CWD_ENV]: "dev/a-project" })).toBeNull();
  });
});

describe("resolveSubscriberId", () => {
  const listPeers = async () => [SESSION, OTHER];

  it("files under the calling session's own hive id, not the plugin's directory", async () => {
    const r = await resolveSubscriberId({
      cwd: WORKSPACE,
      listPeers,
    });
    expect(r).toMatchObject({ ok: true, stableId: SESSION.stable_id, source: "hive-peer" });
  });

  it("matches a session registered under a different spelling of the same directory", () => {
    // /Users/<me>/dev is a symlink to the real volume on this machine, so the
    // two strings hash differently while naming one directory.
    const root = mkdtempSync(join(tmpdir(), "sentry-id-"));
    const real = join(root, "real-project");
    mkdirSync(real);
    const alias = join(root, "alias-project");
    symlinkSync(real, alias);

    const via = peer("abc123abc123", realpathSync(real), null);
    expect(peersAtCwd([via], alias).map((p) => p.stable_id)).toEqual(["abc123abc123"]);
  });

  it("matches on git_root when the session's cwd is recorded there", async () => {
    const gitOnly = peer("deadbeefcafe", "/somewhere/else", WORKSPACE);
    const r = await resolveSubscriberId({ cwd: WORKSPACE, listPeers: async () => [gitOnly] });
    expect(r).toMatchObject({ ok: true, stableId: "deadbeefcafe" });
  });

  it("refuses rather than guessing when no live session owns the cwd", async () => {
    // This is the old bug's exact shape: the server's own cwd is the plugin
    // install directory, which belongs to no session.
    const r = await resolveSubscriberId({ cwd: PLUGIN_DIR, listPeers });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(PLUGIN_DIR);
  });

  it("refuses when the launcher passed no cwd at all", async () => {
    const r = await resolveSubscriberId({ cwd: null, listPeers });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(SESSION_CWD_ENV);
  });

  it("refuses when the broker is unreachable instead of falling back to a hash", async () => {
    const r = await resolveSubscriberId({
      cwd: WORKSPACE,
      listPeers: async () => {
        throw new Error("connection refused");
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("connection refused");
  });

  it("refuses when two live sessions share the workspace", async () => {
    const twin = peer("ffffffffffff", WORKSPACE, WORKSPACE);
    const r = await resolveSubscriberId({ cwd: WORKSPACE, listPeers: async () => [SESSION, twin] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ambiguous");
  });

  it("collapses two sessions of the same peer id to one answer", async () => {
    const sameSession = peer(SESSION.stable_id, WORKSPACE, WORKSPACE);
    const r = await resolveSubscriberId({
      cwd: WORKSPACE,
      listPeers: async () => [SESSION, sameSession],
    });
    expect(r).toMatchObject({ ok: true, stableId: SESSION.stable_id });
  });

  it("takes an explicit stable_id without consulting the broker", async () => {
    const r = await resolveSubscriberId({
      explicitStableId: "0123456789ab",
      cwd: null,
      listPeers: async () => {
        throw new Error("broker must not be consulted");
      },
    });
    expect(r).toMatchObject({ ok: true, stableId: "0123456789ab", source: "explicit" });
  });

  it("rejects a malformed explicit stable_id rather than filing under it", async () => {
    for (const bad of ["2a6518a9227", "2A6518A92270", "not-an-id", "2a6518a92270x"]) {
      const r = await resolveSubscriberId({ explicitStableId: bad, cwd: WORKSPACE, listPeers });
      expect(r.ok).toBe(false);
    }
  });
});
