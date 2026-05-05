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

## Quick start

```bash
bun install

# Start the receiver (one per machine; manage via launchd in production)
bun receiver.ts

# The MCP server starts automatically per Claude Code session if registered
# in your .mcp.json. From a Claude Code session, use:
#   sentry_watch_project(project_slug="bike-map", min_level="warning")
```

See [SETUP.md](./SETUP.md) for Sentry webhook configuration + Cloudflare tunnel deployment.

## Subscription model

Each peer subscribes to one or more Sentry projects with a minimum severity threshold. Events with `level >= min_level` get delivered. Defaults to `warning`.

Levels: `debug` < `info` < `warning` < `error` < `fatal`.

Example: bike-map peer subscribes to project `bike-map` with `min_level=warning` → gets warnings, errors, and fatals; ignores debug/info.

## License

MIT
