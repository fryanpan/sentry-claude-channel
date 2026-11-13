# sentry-claude-channel

Sentry issue events delivered to subscribed Claude Code sessions as `<channel source="claude-hive">` notifications, via [claude-hive](https://github.com/fryanpan/claude-peers-mcp).

Mirrors the architecture of [notion-channel-mcp](https://github.com/fryanpan/notion-channel-mcp) and [github-claude-channel](https://github.com/fryanpan/github-claude-channel).

## What it does

When a new Sentry issue fires (or an existing one changes status), the receiver daemon looks up which Claude Code peers are subscribed to that project, and pushes the event to each via claude-hive. Subscriptions persist across session restarts because they're keyed on the workspace stable_id.

That id is taken from claude-hive's own live peer list rather than computed here. The MCP server runs from the plugin's install directory, not the session's, so its `process.cwd()` names no session at all — deriving an id from it addressed every session's events to the same nonexistent peer, and nothing reported a failure because the broker accepts a message for an unknown id. The launcher passes the session's cwd, the server matches it against the broker's live peers, and it returns an error naming the directory it tried rather than guessing when no peer owns it.

## Architecture

- `receiver.ts` — long-running HTTP daemon. Receives Sentry webhook POSTs at `/webhook`, verifies HMAC signature, fan-outs to subscribed peers via claude-hive `/send-message`. Runs behind a tunnel that gives Sentry a public HTTPS URL.
- `server.ts` — per-Claude-session MCP server. Provides `sentry_watch_project`, `sentry_unwatch_project`, `sentry_list_my_watches` tools.
- `shared/db.ts` — SQLite subscription store at `~/.sentry-channel.db` (WAL mode; receiver and MCP server both open it).
- `shared/hive.ts` — thin HTTP client for the claude-hive broker.
- `shared/session-id.ts` — works out which session is calling, from the cwd the launcher captured plus claude-hive's live peer list. Refuses rather than guessing.
- `scripts/remap-subscriptions.ts` — one-off repair for rows filed under a wrong id (dry-run by default).
- `shared/types.ts` — Sentry webhook payload + subscription types.
- `shared/board.ts` — files new issues as tasks on a claude-workspaces board, comments on repeats, and refreshes each board's token.

## Requirements

[bun](https://bun.sh) — the server uses `bun:sqlite` and other Bun APIs, so node is not a
substitute. You do not need bun on your `PATH`: the plugin ships a `/bin/sh` launcher that
finds bun itself, so it works in sessions started by launchd, a GUI app, or cron, where
your shell profile never runs.

Optional overrides (`SENTRY_RECEIVER_PORT`, `CLAUDE_HIVE_URL`, `SENTRY_CHANNEL_DB`) go in
`~/.config/sentry-claude-channel/env`, which the launcher sources at startup. Keep them
there rather than inside the plugin directory — the plugin cache is keyed by version, so
each release installs into a fresh directory and anything written inside is orphaned by
the next upgrade. `SENTRY_CLIENT_SECRET` is not needed by the MCP server; the receiver
reads it from macOS Keychain (see [SETUP.md](./SETUP.md)).

## Install

### As a Claude Code plugin (recommended)

This repo is a Claude Code plugin. Install it via the standard plugin flow — the MCP server and a PreToolUse auto-approve hook ship together, so you don't have to hand-edit `~/.claude.json` per session:

```bash
# Add this checkout as a local plugin marketplace
claude plugin marketplace add /path/to/sentry-claude-channel

# Install the plugin from that marketplace
claude plugin install sentry-claude-channel@sentry-claude-channel
```

The plugin registers an MCP server named `sentry-claude-channel` (exposing the `sentry_*` tools) and a PreToolUse hook that auto-approves the plugin's own MCP tools + a narrow allowlist of receiver lifecycle commands (`./scripts/run-receiver.sh`, `bun receiver.ts`, and `launchctl` ops scoped to the `com.fryanpan.sentry-channel-receiver` / `com.fryanpan.sentry-bridge-cloudflared` service labels).

You still need to set up the receiver daemon, the Sentry integration, and the Cloudflare tunnel once per machine — see [SETUP.md](./SETUP.md).

### As a raw MCP entry (fallback)

If you prefer to wire up the MCP server manually (e.g. you're on a Claude Code version without plugin support, or you don't want the auto-approve hook), add the server directly to your `.mcp.json` or `~/.claude.json`:

```json
{
  "mcpServers": {
    "sentry-claude-channel": {
      "command": "bun",
      "args": ["/path/to/sentry-claude-channel/server.ts"]
    }
  }
}
```

You'll then be prompted to approve each `mcp__sentry-claude-channel__*` tool the first time Claude Code uses it.

## Quick start

```bash
bun install

# Start the receiver (one per machine; manage via launchd in production).
# It needs SENTRY_CLIENT_SECRET; the launcher reads it from Keychain.
./scripts/run-receiver.sh

# From a Claude Code session, once the plugin (or raw MCP entry) is installed:
#   sentry_watch_project(project_slug="my-app", min_level="warning")
```

See [SETUP.md](./SETUP.md) for Sentry webhook configuration + Cloudflare tunnel deployment.

## Subscription model

Each peer subscribes to one or more Sentry projects with a minimum severity threshold. Events with `level >= min_level` get delivered. Defaults to `warning`.

Levels: `debug` < `info` < `warning` < `error` < `fatal`.

Example: a session subscribes to project `my-app` with `min_level=warning` → gets warnings, errors, and fatals; ignores debug/info.

## Filing issues on a board

A claude-hive message only reaches a session that is running. A project can also be routed to a claude-workspaces board, and the receiver then files each new issue as a task there itself.

- **A new issue** (`created`) at or above the route's level (default `error`) files one task. The title holds only fields Sentry assigns (level, short id, project); the error text goes in the body.
- **The same issue again** (filed before, or `unresolved` after a regression) adds a comment to that task instead of filing a second. The issue-to-task map lives in the bridge's database. A claim row stops two webhooks for one issue from filing twice, and each comment carries a request id, so a webhook Sentry retries posts once. If the task was deleted on the board, the issue files fresh.
- **Resolved, ignored and other actions, and unknown levels,** file nothing.
- **Filing never delays the ack to Sentry.** It runs after the response, with a 10-second timeout.
- **Retries:** a filing that certainly saved nothing (board not running, a 5xx, no token yet, or over the hourly cap) is queued in the database and retried with backoff (1, 2, 4 ... minutes, capped at 6 hours) for about two days, then logged as given up. Each project's queue holds at most 50 issues; past that, new issues are dropped and logged.
- **No duplicates:** a create that was sent but got no answer or an unreadable one, or was cut off by a receiver restart, is **not** retried, because the board may hold it. It is logged as an error (a receiver restart mid-create is also logged at startup), and that issue is not filed again until someone checks the board. Once you have looked, clear it so the issue can file again:

  ```bash
  sqlite3 ~/.sentry-channel.db "DELETE FROM filed_issues WHERE issue_id = '<sentry issue id>' AND task_id IN ('unknown', 'pending');"
  ```

  If the board already has the task, record it instead, so repeats comment on it: `UPDATE filed_issues SET task_id = '<task id>' WHERE issue_id = '<sentry issue id>';`

Set it up once per board:

1. Mint a board agent token on the machine running the board server: `POST /api/board-tokens` with `{agentId, boardId, label}` (loopback only).
2. Store it in the Keychain where the receiver looks for it (see [SETUP.md](./SETUP.md#board-tokens)).
3. From any session, call `sentry_route_to_board` with the project slug, the board server's loopback URL and the board id. `sentry_list_board_routes` and `sentry_unroute_from_board` manage routes.

Routes are kept only in the local database, never in this repository.

**Security.**

- The receiver only ever sends a board token to a loopback address (`localhost`, `127.0.0.1` or `[::1]`) and refuses redirects, so a mistaken or hostile route cannot hand a token to another host.
- The Keychain entry's name is derived from the board id, so a route can't point the receiver at some other secret. Every `security` call is killed after 5 seconds, so a locked Keychain can't hang the receiver, and the HTTP server starts before any board work.
- **Reported error text is untrusted.** For a project whose DSN ships in a web page, anyone can send events with text they choose. That text goes in a code block in the task body (so it can't render as headings, links or images) under a line saying it's untrusted, never in the title, and each route files at most 10 new tasks an hour.
- Board tokens last 7 days. The receiver refreshes each one at startup and then daily, writing the new value back to the Keychain; if that write fails, it keeps the new token in memory and tries the write again at the next refresh. If a token has already expired or been revoked, filings are queued and logged as errors until the board gets a fresh mint.

**Not supported yet:** boards that are not on the same machine as the receiver.

## License

MIT
