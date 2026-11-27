import { APPROVED_PUBLIC_FEEDS } from "../source-allowlist";
import type { GuanlanPrincipal } from "../mcp/auth";
import {
  createD1SubscriptionReader,
  subjectFromPrincipal,
  type ConfigurationOrigin,
  type EffectiveInterest,
  type SubscriptionLevel,
} from "../subscriptions";

export type ManagementSource = {
  readonly sourceId: string | null;
  readonly label: string;
  readonly url: string;
  readonly registered: boolean;
  readonly schedulerIntervalHours: number | null;
  readonly dueAt: string | null;
  readonly lastStatus: string | null;
  readonly lastError: string | null;
  readonly lastCheckedAt: string | null;
  readonly retryCount: number | null;
  readonly accountIntervalHours: number | null;
  readonly consumerIntervalHours: number | null;
  readonly effectiveOrigin: ConfigurationOrigin | null;
  readonly effectiveIntervalHours: number | null;
  readonly effectiveIntervalSource: SubscriptionLevel | null;
};

export type ManagementSnapshot = {
  readonly accountId: string;
  readonly consumerId: string;
  readonly sources: readonly ManagementSource[];
  readonly interests: readonly EffectiveInterest[];
};

export class ManagementReadError extends Error {
  readonly code: "subject_unavailable" | "storage_failure";

  constructor(code: "subject_unavailable" | "storage_failure", message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ManagementReadError";
    this.code = code;
  }
}

type SourceRow = {
  id: string;
  url: string;
  interval_hours: number;
  due_at: string;
  last_status: string | null;
  last_error: string | null;
  last_checked_at: string | null;
  retry_count: number;
};
type SubscriptionRow = { source_id: string; interval_hours: number };

function rowsOf<T>(result: D1Result<unknown> | undefined): T[] {
  if (!result?.success || !Array.isArray(result.results)) {
    throw new ManagementReadError("storage_failure", "management_snapshot_failed");
  }
  return result.results as T[];
}

export async function readManagementSnapshot(
  db: D1Database,
  principal: GuanlanPrincipal,
): Promise<ManagementSnapshot> {
  const subject = subjectFromPrincipal(principal);
  const reader = createD1SubscriptionReader(db);

  let effective;
  try {
    const read = await reader.read(subject);
    if (!read.ok) throw new ManagementReadError("subject_unavailable", read.failure);
    effective = read.effective;
  } catch (error) {
    if (error instanceof ManagementReadError) throw error;
    throw new ManagementReadError("storage_failure", "management_snapshot_failed", { cause: error });
  }

  let batch: D1Result<unknown>[];
  try {
    batch = await db.batch([
      db.prepare(`
        SELECT id,url,interval_hours,due_at,last_status,last_error,last_checked_at,retry_count
          FROM poc_sources
         ORDER BY url
      `),
      db.prepare(`
        SELECT source_id, interval_hours
          FROM guanlan_account_subscriptions
         WHERE account_id = ?
      `).bind(subject.accountId),
      db.prepare(`
        SELECT source_id, interval_hours
          FROM guanlan_consumer_subscriptions
         WHERE account_id = ? AND consumer_id = ?
      `).bind(subject.accountId, subject.consumerId),
    ]);
  } catch (error) {
    throw new ManagementReadError("storage_failure", "management_snapshot_failed", { cause: error });
  }

  const sourceRows = rowsOf<SourceRow>(batch[0]);
  const accountRows = rowsOf<SubscriptionRow>(batch[1]);
  const consumerRows = rowsOf<SubscriptionRow>(batch[2]);

  const sourceByUrl = new Map(sourceRows.map(row => [row.url, row]));
  const sourceById = new Map(sourceRows.map(row => [row.id, row]));
  const approvedUrls = new Set(APPROVED_PUBLIC_FEEDS.map(feed => feed.url));
  const accountBySource = new Map(accountRows.map(row => [row.source_id, row.interval_hours]));
  const consumerBySource = new Map(consumerRows.map(row => [row.source_id, row.interval_hours]));
  const effectiveBySource = new Map(effective.sources.map(source => [source.sourceId, source]));

  for (const source of effective.sources) {
    const stored = sourceById.get(source.sourceId);
    if (!stored || !approvedUrls.has(stored.url)) {
      throw new ManagementReadError(
        "storage_failure",
        "management_source_outside_approved_catalog",
      );
    }
  }

  const sources = APPROVED_PUBLIC_FEEDS.map(feed => {
    const row = sourceByUrl.get(feed.url) ?? null;
    const effectiveSource = row ? effectiveBySource.get(row.id) ?? null : null;
    return {
      sourceId: row?.id ?? null,
      label: feed.label,
      url: feed.url,
      registered: row !== null,
      schedulerIntervalHours: row?.interval_hours ?? null,
      dueAt: row?.due_at ?? null,
      lastStatus: row?.last_status ?? null,
      lastError: row?.last_error ?? null,
      lastCheckedAt: row?.last_checked_at ?? null,
      retryCount: row?.retry_count ?? null,
      accountIntervalHours: row ? accountBySource.get(row.id) ?? null : null,
      consumerIntervalHours: row ? consumerBySource.get(row.id) ?? null : null,
      effectiveOrigin: effectiveSource?.origin ?? null,
      effectiveIntervalHours: effectiveSource?.intervalHours ?? null,
      effectiveIntervalSource: effectiveSource?.intervalSource ?? null,
    } satisfies ManagementSource;
  });

  return {
    accountId: effective.accountId,
    consumerId: effective.consumerId,
    sources,
    interests: effective.interests,
  };
}
