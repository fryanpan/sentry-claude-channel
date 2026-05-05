#!/usr/bin/env bash
# Launch the sentry-claude-channel receiver, pulling the Sentry Client Secret
# from macOS Keychain so the secret never lives in env files, plists, or
# shell history.
#
# Keychain lookup uses:
#   service = sentry-channel-client-secret
#   account = $USER
#
# Add it once with:
#   security add-generic-password -U \
#     -s sentry-channel-client-secret \
#     -a "$USER" \
#     -w '<the-secret>' \
#     -j 'Sentry Internal Integration Client Secret'

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

SECRET="$(
  security find-generic-password \
    -s 'sentry-channel-client-secret' \
    -a "$USER" \
    -w 2>/dev/null
)" || {
  echo "ERROR: sentry-channel-client-secret not found in Keychain." >&2
  echo "Add it via: security add-generic-password -U -s sentry-channel-client-secret -a \$USER -w '<secret>'" >&2
  exit 1
}

export SENTRY_CLIENT_SECRET="$SECRET"
unset SECRET

cd "$REPO_ROOT"
exec bun receiver.ts
