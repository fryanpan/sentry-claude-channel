/**
 * sentry-claude-channel MCP server.
 *
 * One instance per Claude Code session. Provides tools so the session can
 * subscribe to Sentry projects and have new-issue events delivered as
 * channel notifications via claude-hive.
 *
 * Tools:
 *   - sentry_watch_project(project_slug, min_level?)
 *   - sentry_unwatch_project(project_slug)
 *   - sentry_list_my_watches()
 *
 * Subscriptions persist across session restarts (keyed on workspace
 * stable_id). Inbound events are sent through claude-hive — they appear
 * to the Claude Code session as `<channel source="claude-hive" ...>` blocks.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  addSubscription,
  removeSubscription,
  listSubscriptionsFor,
} from "./shared/db.ts";
import { listPeers } from "./shared/hive.ts";
import { resolveSubscriberId, sessionCwd } from "./shared/session-id.ts";
import type { SentryLevel } from "./shared/types.ts";

const VALID_LEVELS: readonly SentryLevel[] = [
  "debug",
  "info",
  "warning",
  "error",
  "fatal",
];

/**
 * Which session is calling. NOT derived from process.cwd() — see
 * shared/session-id.ts for why that was wrong and silent.
 */
async function subscriberId(args: unknown) {
  return resolveSubscriberId({
    explicitStableId: (args as { stable_id?: string } | undefined)?.stable_id,
    cwd: sessionCwd(),
    listPeers,
  });
}

function errorResult(text: string) {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

const server = new Server(
  { name: "sentry-claude-channel", version: "0.3.0" },
  {
    capabilities: { tools: {} },
    instructions: `You have access to the sentry-claude-channel tools. Use them to subscribe to Sentry projects whose new issues you want to see as channel events.

- On startup, if your workspace owns a Sentry project (one of the projects in https://bryans-team.sentry.io/projects/), call \`sentry_watch_project\` once with the project slug. Default min_level is \"warning\" — fatal/error/warning will surface, info/debug will not.
- Subscriptions persist across session restarts (they're keyed on your workspace stable_id), so you don't have to re-subscribe every session. Use \`sentry_list_my_watches\` first to see your current set.
- Inbound Sentry events arrive as <channel source="claude-hive" ...> messages. They contain the project slug, level, title, culprit, event/user counts, and a permalink to the Sentry issue. Treat them as peer taps — investigate promptly.
`,
  },
);

const TOOLS = [
  {
    name: "sentry_watch_project",
    description:
      "Subscribe this workspace to Sentry issue events for a given project. The subscription is keyed by stable workspace ID, so it survives session restarts. Idempotent — re-subscribing updates the min_level filter.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_slug: {
          type: "string" as const,
          description:
            'The Sentry project slug (e.g. "bike-map", "ht-worker", "fryanpan_website"). See https://bryans-team.sentry.io/projects/ for the canonical list.',
        },
        min_level: {
          type: "string" as const,
          enum: ["debug", "info", "warning", "error", "fatal"],
          description:
            'Minimum severity level to receive events for. Defaults to "warning" (warning/error/fatal will surface; debug/info will not).',
        },
        stable_id: {
          type: "string" as const,
          description:
            "Override the session this applies to, as a 12-hex-char claude-hive stable id (claude-hive's whoami tool reports it). Only needed when the session cannot be identified automatically — the tool says so when that happens.",
        },
      },
      required: ["project_slug"],
    },
  },
  {
    name: "sentry_unwatch_project",
    description:
      "Remove a subscription previously created by sentry_watch_project. No-op if no matching subscription exists.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_slug: {
          type: "string" as const,
          description: "The Sentry project slug to unsubscribe from.",
        },
        stable_id: {
          type: "string" as const,
          description:
            "Override the session this applies to, as a 12-hex-char claude-hive stable id (claude-hive's whoami tool reports it). Only needed when the session cannot be identified automatically — the tool says so when that happens.",
        },
      },
      required: ["project_slug"],
    },
  },
  {
    name: "sentry_list_my_watches",
    description:
      "List all Sentry project subscriptions for this workspace. Returns project slug, min_level, and creation timestamp for each.",
    inputSchema: {
      type: "object" as const,
      properties: {
        stable_id: {
          type: "string" as const,
          description:
            "Override the session this applies to, as a 12-hex-char claude-hive stable id (claude-hive's whoami tool reports it). Only needed when the session cannot be identified automatically — the tool says so when that happens.",
        },
      },
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "sentry_watch_project": {
      const projectSlug = String((args as { project_slug?: string }).project_slug ?? "").trim();
      const minLevelInput = String(
        (args as { min_level?: string }).min_level ?? "warning",
      ).toLowerCase() as SentryLevel;
      if (!projectSlug) {
        return errorResult("project_slug is required");
      }
      if (!VALID_LEVELS.includes(minLevelInput)) {
        return errorResult(`min_level must be one of: ${VALID_LEVELS.join(", ")}`);
      }
      const who = await subscriberId(args);
      if (!who.ok) return errorResult(who.error);
      addSubscription(who.stableId, projectSlug, minLevelInput);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Subscribed to Sentry project '${projectSlug}' (min_level=${minLevelInput}).\n` +
              `Events will be addressed to stable_id ${who.stableId}` +
              (who.source === "explicit"
                ? " (passed explicitly)."
                : ` — the live claude-hive peer at ${who.matchedCwd}.`),
          },
        ],
      };
    }

    case "sentry_unwatch_project": {
      const projectSlug = String((args as { project_slug?: string }).project_slug ?? "").trim();
      if (!projectSlug) {
        return errorResult("project_slug is required");
      }
      const who = await subscriberId(args);
      if (!who.ok) return errorResult(who.error);
      const removed = removeSubscription(who.stableId, projectSlug);
      return {
        content: [
          {
            type: "text" as const,
            text: removed
              ? `Unsubscribed from '${projectSlug}'.`
              : `No subscription found for '${projectSlug}' (no-op).`,
          },
        ],
      };
    }

    case "sentry_list_my_watches": {
      const who = await subscriberId(args);
      if (!who.ok) return errorResult(who.error);

      // Show the id each row is ADDRESSED TO, and whether a live session holds
      // it. A misfiled row is otherwise invisible: the tool used to report the
      // id it had just looked up under, which always agreed with itself.
      let live = false;
      try {
        live = (await listPeers()).some((p) => p.stable_id === who.stableId);
      } catch {
        live = false;
      }

      const subs = listSubscriptionsFor(who.stableId);
      const header =
        `Subscriptions addressed to stable_id ${who.stableId}` +
        (who.source === "explicit" ? " (passed explicitly)" : ` (this session, cwd ${who.matchedCwd})`) +
        (live ? " — a live claude-hive peer holds this id." : " — WARNING: no live claude-hive peer holds this id, so events sent to it will not arrive.");

      if (subs.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${header}\n\nNo active subscriptions. Use sentry_watch_project to add one.`,
            },
          ],
        };
      }
      const lines = subs
        .map(
          (s) =>
            `- ${s.project_slug} (min_level=${s.min_level}, since ${s.created_at}) -> ${s.peer_stable_id}`,
        )
        .join("\n");
      return {
        content: [{ type: "text" as const, text: `${header}\n${lines}` }],
      };
    }

    default:
      return errorResult(`unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
