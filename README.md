# sentry-claude-channel

Sentry issue events delivered to subscribed Claude Code sessions as `<channel source="claude-hive">` notifications, via [claude-hive](https://github.com/fryanpan/claude-peers-mcp).

Mirrors the architecture of [notion-channel-mcp](https://github.com/fryanpan/notion-channel-mcp) and [github-claude-channel](https://github.com/fryanpan/github-claude-channel).

## What it does

When a new Sentry issue fires (or an existing one changes status), the receiver daemon looks up which Claude Code peers are subscribed to that project, and pushes the event to each via claude-hive. Subscriptions persist across session restarts because they're keyed on the workspace stable_id.

## Architecture

- `receiver.ts` — long-running HTTP daemon. Receives Sentry webhook POSTs at `/webhook`, verifies HMAC signature, fan-outs to subscribed peers via claude-hive `/send-message`. Runs behind a Cloudflare tunnel at `sentry-bridge.fryanpan.com`.
- `server.ts` — per-Claude-session MCP server. Provides `sentry_watch_project`, `sentry_unwatch_project`, `sentry_list_my_watches` tools.
- `shared/db.ts` — SQLite subscription store at `~/.sentry-channel.db` (WAL mode; receiver and MCP server both open it).
- `shared/hive.ts` — thin HTTP client for the claude-hive broker.
- `shared/stable-id.ts` — workspace stable-id derivation (matches claude-hive's scheme).
- `shared/types.ts` — Sentry webhook payload + subscription types.

## Install

### As a Claude Code plugin (recommended)

This repo is a Claude Code plugin. Install it via the standard plugin flow — the MCP server and a PreToolUse auto-approve hook ship together, so you don't have to hand-edit `~/.claude.json` per session:

```bash
# Add this checkout as a local plugin marketplace
claude plugin marketplace add /Users/bryanchan/dev/sentry-claude-channel

# Install the plugin from that marketplace
claude plugin install sentry-claude-channel@sentry-claude-channel
```

The plugin registers an MCP server named `sentry-claude-channel` (exposing the `sentry_*` tools) and a PreToolUse hook that auto-approves the plugin's own MCP tools + a narrow allowlist of receiver lifecycle commands (`./scripts/run-receiver.sh`, `bun receiver.ts`, and `launchctl` ops scoped to the `sentry-channel.receiver` / `sentry-bridge.cloudflared` service labels).

You still need to set up the receiver daemon, the Sentry integration, and the Cloudflare tunnel once per machine — see [SETUP.md](./SETUP.md).

### As a raw MCP entry (fallback)

If you prefer to wire up the MCP server manually (e.g. you're on a Claude Code version without plugin support, or you don't want the auto-approve hook), add the server directly to your `.mcp.json` or `~/.claude.json`:

```json
{
  "mcpServers": {
    "sentry-claude-channel": {
      "command": "bun",
      "args": ["/Users/bryanchan/dev/sentry-claude-channel/server.ts"]
    }
  }
}
```

You'll then be prompted to approve each `mcp__sentry-claude-channel__*` tool the first time Claude Code uses it.

## Quick start

```bash
bun install

# Start the receiver (one per machine; manage via launchd in production)
bun receiver.ts

# From a Claude Code session, once the plugin (or raw MCP entry) is installed:
#   sentry_watch_project(project_slug="bike-map", min_level="warning")
```

See [SETUP.md](./SETUP.md) for Sentry webhook configuration + Cloudflare tunnel deployment.

## Subscription model

Each peer subscribes to one or more Sentry projects with a minimum severity threshold. Events with `level >= min_level` get delivered. Defaults to `warning`.

Levels: `debug` < `info` < `warning` < `error` < `fatal`.

Example: bike-map peer subscribes to project `bike-map` with `min_level=warning` → gets warnings, errors, and fatals; ignores debug/info.

## License

MIT
