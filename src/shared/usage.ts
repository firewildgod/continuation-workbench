import type { Engine, Protocol } from './types';

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
}
export interface UsagePricing {
  currency: 'CNY';
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  source?: string;
  updatedAt?: string;
  origin?: 'official' | 'manual';
  sourceKind?: 'builtin' | 'network' | 'manual';
  sourceUrl?: string;
  verifiedAt?: string;
  contextMaxTokens?: number;
  note?: string;
}
export interface UsageCapture {
  connectionId: string;
  connectionName: string;
  engine: Engine;
  model: string;
  startedAt: string;
  finishedAt: string;
  httpStatus: number;
  outcome: 'success' | 'error' | 'cancelled';
  tokens: UsageTokens | null;
  pricing?: UsagePricing;
  kind?: 'request' | 'connection-test';
  surface?: 'desktop' | 'cli';
}
export interface UsageRecord extends UsageCapture {
  id: string;
  costCNY: number | null;
  pricing?: UsagePricing;
}
export interface UsageTotals {
  costCNY: number | null;
  knownCostCNY: number;
  requestCount: number;
  successCount: number;
  failedCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  unpricedRequests: number;
  unknownUsageRequests: number;
  pricedRequests: number;
}
export interface UsageDay extends UsageTotals { date: string; }
export interface UsageConnectionTotal extends UsageTotals {
  connectionId: string; name: string; model: string; engine: Engine;
}
export interface UsageModelTotal extends UsageTotals { model: string; }
export interface UsageSummary {
  warning?: string;
  timezone: 'Asia/Shanghai';
  today: UsageTotals;
  month: UsageTotals;
  daily: UsageDay[];
  byConnection: UsageConnectionTotal[];
  byModel: UsageModelTotal[];
  records: UsageRecord[];
  startedAt: string | null;
}
export interface UsageQuery { limit?: number; range?: 'today' | 'month' | 'all'; }

/** Public quote lookups use metadata only, never API keys or credential flags. */
export interface OfficialPricingTarget {
  connectionId: string; name: string; model: string; baseUrl: string;
  presetId: string; engine: Engine; protocol: Protocol;
  pricing?: UsagePricing; pricingMode?: 'official' | 'manual';
}
export interface OfficialPricingResult {
  connectionId: string;
  status: 'updated' | 'unchanged' | 'manual-skipped' | 'unsupported' | 'failed' | 'changed-skipped';
  message: string;
  pricing?: UsagePricing;
}
export interface OfficialPricingRefreshInput { connectionIds?: string[]; forceManual?: boolean; }
export interface OfficialPricingRefreshReport {
  updatedAt: string; results: OfficialPricingResult[]; updatedCount: number;
  manualSkippedCount: number; unsupportedCount: number; failedCount: number;
  warnings: string[];
}
