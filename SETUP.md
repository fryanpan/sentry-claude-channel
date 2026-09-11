# Setup — sentry-claude-channel

End-to-end setup for routing Sentry issue events to your Claude Code peers.

## 1. Receiver daemon

```bash
cd ~/dev/sentry-claude-channel
bun install
```

Set environment variables before running:

| var | required | default | meaning |
|---|---|---|---|
| `SENTRY_CLIENT_SECRET` | yes (prod) | — | Sentry integration's Client Secret. Used to verify webhook signatures. If unset, the receiver runs in **dev mode** with no signature verification. **Stored in macOS Keychain** — service `sentry-channel-client-secret`, account `$USER`. Don't hard-code it; load via the launcher pattern below. |
| `SENTRY_RECEIVER_PORT` | no | `7903` | HTTP port for the receiver. |
| `SENTRY_CHANNEL_DB` | no | `~/.sentry-channel.db` | SQLite subscription store path. |
| `CLAUDE_HIVE_URL` | no | `http://127.0.0.1:7900` | claude-hive broker URL. |

Run via the launcher script (reads secret from Keychain, no plaintext on disk):

```bash
./scripts/run-receiver.sh
```

Or directly for dev (signature verification disabled):

```bash
bun receiver.ts
```

Verify it's healthy:

```bash
curl -s http://127.0.0.1:7903/health   # → "ok"
```

### Storing the Sentry Client Secret in Keychain

```bash
security add-generic-password \
  -U \
  -s 'sentry-channel-client-secret' \
  -a "$USER" \
  -w '<the-secret-from-sentry-integration>' \
  -j 'Sentry Internal Integration Client Secret for sentry-claude-channel receiver.'
```

Verify (does NOT print the value):

```bash
security find-generic-password -s 'sentry-channel-client-secret' -a "$USER" -j
```

To rotate: re-run the `add-generic-password` command above with the new value. The `-U` flag updates if the entry already exists.

### Production: launchd

Mirror `notion-channel-mcp/launchd/notion-channel.cloudflared.plist`. Have the plist exec `scripts/run-receiver.sh` rather than embedding env vars (so the plist file itself contains no secrets).

## 2. Cloudflare tunnel for the public webhook URL

Sentry needs to reach the receiver from the internet. Use a Cloudflare tunnel that maps `sentry-bridge.fryanpan.com` → `http://127.0.0.1:7903`.

```bash
cloudflared tunnel route dns <tunnel-name> sentry-bridge.fryanpan.com
```

Add the route to your tunnel config (`~/.cloudflared/config.yml`):

```yaml
ingress:
  - hostname: sentry-bridge.fryanpan.com
    service: http://localhost:7903
  - service: http_status:404
```

Restart cloudflared. Verify externally:

```bash
curl -s https://sentry-bridge.fryanpan.com/health   # → "ok"
```

## 3. Sentry webhook configuration

Create a Sentry **Internal Integration** (Settings → Developer Settings → New Internal Integration):

- **Name:** `Claude channel bridge` (or similar)
- **Webhook URL:** `https://sentry-bridge.fryanpan.com/webhook`
- **Permissions:** `Issue & Event: Read` (minimum)
- **Webhooks:** check `issue` (and any others you want — `event_alert`, `metric_alert`)
- **Save** → copy the **Client Secret**.

Set `SENTRY_CLIENT_SECRET` in the receiver's environment to that value, then restart the receiver.

## 4. Per-peer subscription

In your Claude Code session, register the MCP server (if not already in `.mcp.json` globally):

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

Then from any Claude Code session, run:

```
sentry_watch_project(project_slug="bike-map", min_level="warning")
```

The peer will start receiving Sentry events for that project as `<channel source="claude-hive">` notifications.

Default `min_level` is `warning`. Pass `min_level="error"` if you only want error+fatal.

## 5. Verification

1. Trigger a test event in Sentry (e.g., manually capture an exception in the watched project).
2. Watch the receiver log — should see `webhook matched` with **`deliverable_peers` ≥ 1**.
   `matched_peers` counts subscription rows that matched; `deliverable_peers` counts the ones whose
   stable_id a live claude-hive peer actually holds. Those two diverge exactly when a subscription is
   misfiled, so checking `matched_peers` alone can read ≥ 1 while nothing was delivered — which is the
   blind spot this step exists to catch. An undeliverable match is also logged separately at `error`
   level naming the offending `to_stable_id`.
3. The watching peer should see a `<channel source="claude-hive">` block within seconds containing the issue title, level, culprit, and Sentry permalink.

## Troubleshooting

- **Receiver returns 403:** signature verification failed. Confirm `SENTRY_CLIENT_SECRET` matches the integration's actual Client Secret. Check Sentry's webhook delivery logs (Integrations → your integration → Dashboard) for the raw body Sentry sent vs what the receiver received.
- **Webhook arrives but no peer gets the message:** check `~/.sentry-channel.db` — `SELECT * FROM subscriptions;` should show the expected row. Also confirm claude-hive is alive: `curl -s http://127.0.0.1:7900/health`.
- **Peer subscribed but events still missing:** the channel-push to idle Claude Code sessions is silently dropped (Claude Code GitHub issue [#40800](https://github.com/anthropics/claude-code/issues/40800)). The peer needs to call `check_messages` (claude-hive tool) at the start of its next turn to drain queued events.

## Installing the receiver as a LaunchAgent

**Deploy to the boot disk. Not to a home-directory path you have not resolved.**

A process spawned by launchd gets `Operation not permitted` on a secondary
volume — on exec, on read, even on stat — unless its own executable holds Full
Disk Access, and `/bin/bash` does not. `~/dev` and `~/.bun` are commonly
symlinks onto another volume, in which case the resolved path is what launchd
uses and the job dies at exec. `launchctl list` still shows it loaded, and
`KeepAlive` restarts it every `ThrottleInterval` seconds forever, so the
failure is only visible in the log.

Pick a deploy root and a bun that are both genuinely on the boot disk, and
confirm it rather than assuming:

```bash
DEPLOY_ROOT=/opt/fleet/sentry-channel      # /opt is boot disk and is not shadowed by a symlink
BUN_BIN_DIR=/path/to/a/boot-disk/bun/bin

readlink -f "$DEPLOY_ROOT"  && df "$DEPLOY_ROOT"
readlink -f "$BUN_BIN_DIR/bun" && df "$BUN_BIN_DIR/bun"
```

Then deploy, fill in the template, and load it:

```bash
rsync -a --exclude='.git' ./ "$DEPLOY_ROOT/"

sed -e "s|DEPLOY_ROOT|$DEPLOY_ROOT|g" \
    -e "s|BUN_BIN_DIR|$BUN_BIN_DIR|g" \
    -e "s|HOME_DIR|$HOME|g" \
    launchd/com.fryanpan.sentry-channel-receiver.plist \
    > ~/Library/LaunchAgents/com.fryanpan.sentry-channel-receiver.plist

launchctl bootstrap "gui/$(id -u)" \
  ~/Library/LaunchAgents/com.fryanpan.sentry-channel-receiver.plist
```

**Verify it is serving, not merely loaded.** These are different states, and
only the first two lines below distinguish them:

```bash
curl -s localhost:7903/health                      # expect: ok
lsof -nP -iTCP:7903 -sTCP:LISTEN                   # expect: the receiver's pid
launchctl print "gui/$(id -u)/com.fryanpan.sentry-channel-receiver" | grep -E 'state|pid'
tail -5 ~/Library/Logs/sentry-channel-receiver.log
```

When reading that log, check the timestamp against the current time. It is
append-only across restarts, so a healthy-looking line near the end can be
from a previous run.
