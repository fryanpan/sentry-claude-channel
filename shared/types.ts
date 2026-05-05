/**
 * Shared types for sentry-claude-channel.
 */

/** First 12 hex chars of sha256(git_root || cwd). Matches claude-hive. */
export type StableId = string;

export interface Subscription {
  id: number;
  peer_stable_id: StableId;
  project_slug: string;
  min_level: SentryLevel;
  created_at: string;
}

export type SentryLevel = "debug" | "info" | "warning" | "error" | "fatal";

export const LEVEL_RANK: Record<SentryLevel, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
  fatal: 4,
};

/** Subset of Sentry's webhook payload that we care about. */
export interface SentryIssueWebhook {
  action: "created" | "resolved" | "assigned" | "ignored" | "archived" | "unresolved";
  data: {
    issue: {
      id: string;
      shortId: string;
      title: string;
      level: SentryLevel;
      culprit: string;
      permalink: string;
      project: {
        id: string;
        slug: string;
        name: string;
      };
      metadata?: {
        type?: string;
        value?: string;
        filename?: string;
        function?: string;
      };
      count?: string;
      userCount?: number;
    };
  };
  installation?: { uuid: string };
  actor?: { type: string; id: string; name: string };
}
