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
import { computeStableId } from "./shared/stable-id.ts";
import type { SentryLevel } from "./shared/types.ts";

const VALID_LEVELS: readonly SentryLevel[] = [
  "debug",
  "info",
  "warning",
  "error",
  "fatal",
];

const myStableId = computeStableId(process.cwd());

const server = new Server(
  { name: "sentry-claude-channel", version: "0.1.0" },
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
      properties: {},
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
        return {
          isError: true,
          content: [{ type: "text" as const, text: "project_slug is required" }],
        };
      }
      if (!VALID_LEVELS.includes(minLevelInput)) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `min_level must be one of: ${VALID_LEVELS.join(", ")}`,
            },
          ],
        };
      }
      addSubscription(myStableId, projectSlug, minLevelInput);
      return {
        content: [
          {
            type: "text" as const,
            text: `Subscribed to Sentry project '${projectSlug}' (min_level=${minLevelInput}, peer_stable_id=${myStableId}).`,
          },
        ],
      };
    }

    case "sentry_unwatch_project": {
      const projectSlug = String((args as { project_slug?: string }).project_slug ?? "").trim();
      if (!projectSlug) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "project_slug is required" }],
        };
      }
      const removed = removeSubscription(myStableId, projectSlug);
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
      const subs = listSubscriptionsFor(myStableId);
      if (subs.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No active subscriptions for stable_id ${myStableId}. Use sentry_watch_project to add one.`,
            },
          ],
        };
      }
      const lines = subs
        .map(
          (s) =>
            `- ${s.project_slug} (min_level=${s.min_level}, since ${s.created_at})`,
        )
        .join("\n");
      return {
        content: [
          {
            type: "text" as const,
            text: `Active subscriptions for stable_id ${myStableId}:\n${lines}`,
          },
        ],
      };
    }

    default:
      return {
        isError: true,
        content: [{ type: "text" as const, text: `unknown tool: ${name}` }],
      };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
