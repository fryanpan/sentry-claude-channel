#!/usr/bin/env bun
/**
 * PreToolUse hook for the sentry-claude-channel plugin.
 *
 * Auto-approves tool calls that fall inside the plugin's own surface so
 * users don't have to "Allow Claude to use <tool>" for every new MCP tool
 * the plugin ships, plus a small allowlist of Bash operations every plugin
 * consumer eventually has to run (receiver lifecycle, launchd supervisor
 * install for the receiver + cloudflared sidecar).
 *
 * Two categories, evaluated independently:
 *
 *   1. **MCP tools published by this plugin**
 *      Tool name matches `mcp__plugin_sentry-claude-channel_sentry-claude-channel__*` → approve.
 *      Rationale: the user opted into the entire MCP surface when they ran
 *      `claude plugin install sentry-claude-channel@…`. Making them re-opt-in
 *      per tool is friction without security value — the MCP server is the
 *      trust boundary, not the individual tool names. Auto-approving here
 *      means new tools shipped in plugin updates don't require every user
 *      to re-edit `~/.claude/settings.json`.
 *
 *   2. **Bash patterns specific to the plugin's lifecycle**
 *      Narrow allowlist of known-safe commands the plugin documents in
 *      the README + SETUP.md:
 *        - `./scripts/run-receiver.sh` (foreground receiver via Keychain launcher)
 *        - `bun receiver.ts` / `bun server.ts` (raw foreground processes)
 *        - `bun run receiver` / `bun run server` (package.json scripts)
 *        - `launchctl {bootstrap,bootout,kickstart,print,list}` against the
 *          plugin's service labels `sentry-channel.receiver` and
 *          `sentry-bridge.cloudflared`
 *      Anything else falls through to Claude Code's normal prompt.
 *
 * Everything outside the plugin's domain (file writes outside the project,
 * destructive ops, third-party MCP tools, etc.) is unaffected — the hook
 * does not fire on those matchers, and even when it does fire on a Bash
 * call it pass-throughs unless the command matches one of the named
 * patterns.
 *
 * On any error (malformed payload, unexpected shape) the hook exits 0
 * with no decision so Claude Code's normal prompt fires — fail-open is
 * safer than fail-block here.
 *
 * Reference design: https://github.com/fryanpan/claude-live-feedback-plugin/pull/40
 */

type HookPayload = {
  tool_name?: string;
  tool_input?: {
    command?: string;
    [key: string]: unknown;
  };
};

type HookDecision = {
  decision?: 'approve' | 'block';
  reason?: string;
};

const MCP_PREFIX = 'mcp__plugin_sentry-claude-channel_sentry-claude-channel__';

/**
 * Service labels owned by this plugin. The launchctl substring matchers
 * below only auto-approve when the command also includes one of these
 * labels, so a `launchctl print` for someone else's service still prompts.
 */
const SERVICE_LABELS = [
  'sentry-channel.receiver',
  'sentry-bridge.cloudflared',
];

/**
 * Anchored prefix matchers for Bash commands the plugin owns.
 * `command.startsWith(pattern)` is sufficient — these are command lines
 * Claude generates from the README's documented dev workflow, not arbitrary
 * shell. Keep the list short; surprise approvals are worse than an extra
 * prompt.
 */
const BASH_PREFIX_ALLOWLIST = [
  './scripts/run-receiver.sh',
  'bun receiver.ts',
  'bun server.ts',
  'bun run receiver',
  'bun run server',
];

/**
 * Substring matchers — for commands where the meaningful pattern can
 * appear with various leading flags or pipes. We keep these scoped to
 * the plugin's service labels so a random `launchctl print` for another
 * service still prompts.
 */
const BASH_SUBSTRING_ALLOWLIST = [
  'launchctl bootstrap gui/', // followed by uid + plist
  'launchctl bootout gui/',
  'launchctl kickstart -k gui/',
  'launchctl print gui/',
  'launchctl list',
];

function approveBash(command: string): { approve: true; reason: string } | null {
  for (const prefix of BASH_PREFIX_ALLOWLIST) {
    if (command.startsWith(prefix)) {
      return { approve: true, reason: `plugin lifecycle: ${prefix}` };
    }
  }
  for (const needle of BASH_SUBSTRING_ALLOWLIST) {
    if (command.includes(needle)) {
      // Require co-occurrence with one of our service labels. This is the
      // guardrail: no broad `launchctl` ops on someone else's service get
      // auto-approved.
      for (const label of SERVICE_LABELS) {
        if (command.includes(label)) {
          return { approve: true, reason: `plugin service mgmt: ${needle} (${label})` };
        }
      }
    }
  }
  return null;
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(Buffer.from(chunk));
  let payload: HookPayload = {};
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    process.exit(0);
  }
  const tool = payload.tool_name;
  if (!tool) process.exit(0);

  // MCP tools owned by this plugin — auto-approve unconditionally.
  if (tool.startsWith(MCP_PREFIX)) {
    const out: HookDecision = {
      decision: 'approve',
      reason: 'sentry-claude-channel plugin MCP tool — user already opted in via plugin install',
    };
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }

  // Bash — check against the narrow allowlist.
  if (tool === 'Bash') {
    const command = payload.tool_input?.command;
    if (typeof command !== 'string') process.exit(0);
    const decision = approveBash(command);
    if (decision) {
      const out: HookDecision = { decision: 'approve', reason: decision.reason };
      process.stdout.write(JSON.stringify(out));
    }
    // No match → exit 0 with no decision; Claude Code prompts normally.
    process.exit(0);
  }

  // Any other tool: pass through.
  process.exit(0);
}

void main();
