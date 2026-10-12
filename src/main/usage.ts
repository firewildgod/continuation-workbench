import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { Protocol } from '../shared/types';
import type { UsageTokens, UsagePricing, UsageCapture, UsageRecord, UsageTotals, UsageSummary, UsageDay, UsageConnectionTotal, UsageModelTotal, UsageQuery } from '../shared/usage';
export type { UsageTokens, UsagePricing, UsageCapture, UsageRecord, UsageTotals, UsageSummary, UsageQuery } from '../shared/usage';

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function modelName(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 250 && !/[\r\n\0]/.test(value) ? value : undefined;
}
/** Decode only whitelisted numeric metadata; never return text, prompts or keys. */
export function normalizeUsage(value: unknown, protocol: Protocol): UsageTokens | undefined {
  const usage = object(value); if (!usage) return undefined;
  const input = count(usage.input_tokens ?? usage.prompt_tokens);
  const output = count(usage.output_tokens ?? usage.completion_tokens);
  const inputDetails = object(usage.input_tokens_details ?? usage.prompt_tokens_details);
  const outputDetails = object(usage.output_tokens_details ?? usage.completion_tokens_details);
  const read = count(usage.cache_read_input_tokens ?? inputDetails?.cached_tokens ?? usage.prompt_cache_hit_tokens);
  const write = count(usage.cache_creation_input_tokens ?? inputDetails?.cache_creation_input_tokens ?? inputDetails?.cache_creation_tokens);
  if (input === undefined || output === undefined) return undefined;
  const tokens: UsageTokens = {
    inputTokens: protocol === 'anthropic' ? input + (read ?? 0) + (write ?? 0) : input,
    outputTokens: output, cacheReadTokens: read ?? 0, cacheWriteTokens: write ?? 0,
    reasoningTokens: count(outputDetails?.reasoning_tokens),
  };
  if (!Number.isSafeInteger(tokens.inputTokens)) return undefined;
  // A malformed provider counter cannot become a negative uncached input charge.
  if (tokens.cacheReadTokens + tokens.cacheWriteTokens > tokens.inputTokens) return undefined;
  return tokens;
}

/** A bounded observer. It never buffers the stream and never changes its chunks. */
export class UsageObserver {
  private decoder = new StringDecoder('utf8');
  private buffer = ''; private eventName = ''; private data: string[] = [];
  private eventBytes = 0; private skipping = false; private jsonOverflow = false;
  private isSSE: boolean; private isJSON: boolean;
  private tokens?: UsageTokens; private observedModel?: string; private complete = false;
  private failed = false;
  private closed = false;
  private anthropicRaw: Record<string, unknown> = {};
  constructor(private protocol: Protocol, contentType: string) {
    this.isSSE = /text\/event-stream/i.test(contentType);
    this.isJSON = /(?:application\/json|\+json)/i.test(contentType);
  }
  write(chunk: Uint8Array | string): void {
    if (this.closed || (!this.isSSE && !this.isJSON) || this.jsonOverflow) return;
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    this.buffer += text;
    if (this.isSSE) {
      let at: number;
      while ((at = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, at).replace(/\r$/, ''); this.buffer = this.buffer.slice(at + 1); this.line(line);
      }
      if (this.buffer.length > 2 * 1024 * 1024) { this.buffer = ''; this.skipping = true; }
    } else if (this.buffer.length > 2 * 1024 * 1024) { this.buffer = ''; this.jsonOverflow = true; }
  }
  private line(line: string): void {
    if (!line) {
      if (!this.skipping && this.data.length) this.parse(this.data.join('\n'), this.eventName);
      this.eventName = ''; this.data = []; this.eventBytes = 0; this.skipping = false; return;
    }
    if (line.startsWith('event:')) this.eventName = line.slice(6).trim();
    else if (line.startsWith('data:') && !this.skipping) {
      // Most token deltas contain no usage. Only retain candidate accounting events.
      const relevant = !this.eventName || /^(?:response\.(?:completed|incomplete|failed|done)|message_(?:start|delta|stop)|error)$/.test(this.eventName);
      if (!relevant) return;
      this.eventBytes += line.length;
      if (this.eventBytes > 2 * 1024 * 1024) { this.data = []; this.skipping = true; return; }
      this.data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  private parse(text: string, eventName = ''): void {
    if (!text) return;
    if (text === '[DONE]') { if (this.tokens) this.complete = true; return; }
    let parsed: Record<string, unknown> | undefined;
    try { parsed = object(JSON.parse(text)); } catch { return; }
    if (!parsed) return;
    const type = typeof parsed.type === 'string' ? parsed.type : eventName;
    if (type === 'error' || type === 'response.failed' || type === 'response.incomplete' || parsed.error) this.failed = true;
    if (this.protocol === 'anthropic') {
      const message = object(parsed.message);
      const usage = object(message?.usage ?? parsed.usage);
      if (usage) {
        // message_delta counters are cumulative, not increments.
        for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
          const value = count(usage[key]); if (value !== undefined) this.anthropicRaw[key] = value;
        }
        this.tokens = normalizeUsage(this.anthropicRaw, this.protocol);
      }
      this.observedModel = modelName(message?.model ?? parsed.model) ?? this.observedModel;
      if (type === 'message_stop' || (!this.isSSE && Boolean(usage))) this.complete = true;
    } else {
      const response = object(parsed.response) ?? parsed;
      if (response.status === 'failed' || response.status === 'incomplete' || response.error) this.failed = true;
      const tokens = normalizeUsage(response.usage, this.protocol);
      if (tokens) this.tokens = tokens;
      this.observedModel = modelName(response.model) ?? this.observedModel;
      if (/^response\.(completed|incomplete|failed|done)$/.test(type) || (!this.isSSE && Boolean(tokens))) this.complete = true;
    }
  }
  finish(transportComplete = true): { tokens?: UsageTokens; model?: string; complete: boolean; failed: boolean } {
    if (!this.closed) {
      this.buffer += this.decoder.end();
      if (this.isSSE) {
        if (this.buffer) this.line(this.buffer.replace(/\r$/, ''));
        this.line('');
      } else if (this.isJSON && !this.jsonOverflow && transportComplete) this.parse(this.buffer);
      this.buffer = ''; this.data = []; this.closed = true;
    }
    return { tokens: this.tokens ? { ...this.tokens } : undefined, model: this.observedModel, complete: this.complete, failed: this.failed };
  }
}

function validRate(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
export function validateUsagePricing(value: unknown): UsagePricing | undefined {
  const price = object(value);
  if (!price || price.currency !== 'CNY' || !validRate(price.inputPerMillion) || !validRate(price.outputPerMillion)) return undefined;
  for (const field of ['cacheReadPerMillion', 'cacheWritePerMillion']) if (price[field] !== undefined && !validRate(price[field])) return undefined;
  return { currency: 'CNY', inputPerMillion: price.inputPerMillion, outputPerMillion: price.outputPerMillion,
    cacheReadPerMillion: price.cacheReadPerMillion as number | undefined, cacheWritePerMillion: price.cacheWritePerMillion as number | undefined,
    source: typeof price.source === 'string' ? price.source.slice(0, 500) : undefined,
    updatedAt: typeof price.updatedAt === 'string' ? price.updatedAt : undefined,
    origin: price.origin === 'official' || price.origin === 'manual' ? price.origin : undefined,
    sourceKind: price.sourceKind === 'builtin' || price.sourceKind === 'network' || price.sourceKind === 'manual' ? price.sourceKind : undefined,
    sourceUrl: typeof price.sourceUrl === 'string' ? price.sourceUrl : undefined,
    verifiedAt: typeof price.verifiedAt === 'string' ? price.verifiedAt : undefined,
    contextMaxTokens: typeof price.contextMaxTokens === 'number' && Number.isSafeInteger(price.contextMaxTokens) && price.contextMaxTokens > 0 ? price.contextMaxTokens : undefined,
    note: typeof price.note === 'string' ? price.note.slice(0, 600) : undefined };
}
export function estimateUsageCost(tokens: UsageTokens | undefined, pricing: UsagePricing | undefined): number | null {
  const price = validateUsagePricing(pricing);
  if (!tokens || !price || count(tokens.inputTokens) === undefined || count(tokens.outputTokens) === undefined) return null;
  const read = count(tokens.cacheReadTokens ?? 0), write = count(tokens.cacheWriteTokens ?? 0);
  if (read === undefined || write === undefined || read + write > tokens.inputTokens!) return null;
  if (read > 0 && price.cacheReadPerMillion === undefined || write > 0 && price.cacheWritePerMillion === undefined) return null;
  return ((tokens.inputTokens! - read - write) * price.inputPerMillion + tokens.outputTokens! * price.outputPerMillion
    + read * (price.cacheReadPerMillion ?? 0) + write * (price.cacheWritePerMillion ?? 0)) / 1_000_000;
}
function emptyTotals(): UsageTotals {
  return { costCNY: 0, knownCostCNY: 0, requestCount: 0, successCount: 0, failedCount: 0, pricedRequests: 0, unpricedRequests: 0, unknownUsageRequests: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
}
function add(total: UsageTotals, row: UsageRecord): void {
  total.requestCount++; if (row.outcome !== 'success') total.failedCount++; else total.successCount++;
  if (row.costCNY === null) total.unpricedRequests++; else { total.pricedRequests++; total.knownCostCNY += row.costCNY; }
  if (!row.tokens) total.unknownUsageRequests++;
  total.inputTokens += row.tokens?.inputTokens ?? 0; total.outputTokens += row.tokens?.outputTokens ?? 0;
  total.cacheReadTokens += row.tokens?.cacheReadTokens ?? 0;
  total.costCNY = total.unpricedRequests ? null : total.knownCostCNY;
}
export function shanghaiDate(date: Date): string { return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); }

/** Append-only local metadata ledger. Prices are snapshotted per call, never repriced retroactively. */
export class UsageLedger {
  readonly filename: string; private rows: UsageRecord[] = []; private pending = Promise.resolve(); private error?: string;
  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true }); this.filename = path.join(dataDir, 'usage-ledger.jsonl');
    if (fs.existsSync(this.filename)) {
      for (const line of fs.readFileSync(this.filename, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as UsageRecord;
          if (!row.id || !row.connectionId || !['codex', 'claude'].includes(row.engine) || !Number.isFinite(Date.parse(row.finishedAt))
            || !(row.costCNY === null || validRate(row.costCNY))) throw new Error('invalid');
          this.rows.push({ ...this.clean(row), id: row.id, costCNY: row.costCNY, pricing: validateUsagePricing(row.pricing) });
        } catch { this.error = '部分费用记录无法读取；完整记录仍可统计。'; }
      }
    }
  }
  private clean(capture: UsageCapture): UsageCapture {
    const tokens = capture.tokens ? normalizeUsage({ input_tokens: capture.tokens.inputTokens, output_tokens: capture.tokens.outputTokens,
      input_tokens_details: { cached_tokens: capture.tokens.cacheReadTokens, cache_creation_tokens: capture.tokens.cacheWriteTokens },
      output_tokens_details: { reasoning_tokens: capture.tokens.reasoningTokens } }, 'responses') ?? null : null;
    return { connectionId: capture.connectionId, connectionName: capture.connectionName, engine: capture.engine,
      model: capture.model, startedAt: capture.startedAt, finishedAt: capture.finishedAt, httpStatus: capture.httpStatus,
      outcome: capture.outcome, kind: capture.kind === 'connection-test' ? 'connection-test' : 'request', tokens,
      ...(capture.surface === 'desktop' || capture.surface === 'cli' ? { surface: capture.surface } : {}) };
  }
  record(capture: UsageCapture, pricing?: UsagePricing): UsageRecord {
    const clean = this.clean(capture), price = validateUsagePricing(pricing);
    const costCNY = estimateUsageCost(clean.tokens ?? undefined, price);
    const row: UsageRecord = { ...clean, id: randomUUID(), costCNY, pricing: price };
    this.rows.push(row);
    this.pending = this.pending.then(() => fs.promises.appendFile(this.filename, JSON.stringify(row) + '\n', { mode: 0o600 }))
      .catch(() => { this.error = '费用记录暂时无法写入磁盘，请检查数据目录。'; });
    return structuredClone(row);
  }
  async flush(): Promise<void> { await this.pending; }
  getError(): string | undefined { return this.error; }
  records(query: UsageQuery = {}, now = new Date()): UsageRecord[] {
    const day = shanghaiDate(now), month = day.slice(0, 7);
    const limit = Number.isFinite(query.limit) ? Math.max(1, Math.min(10000, Math.floor(query.limit!))) : 100;
    return structuredClone(this.rows.filter(row => {
      const rowDay = shanghaiDate(new Date(row.finishedAt));
      return query.range === 'today' ? rowDay === day : query.range === 'month' ? rowDay.slice(0, 7) === month : true;
    }).slice(-limit).reverse());
  }
  summary(now = new Date()): UsageSummary {
    const day = shanghaiDate(now), monthKey = day.slice(0, 7), today = emptyTotals(), month = emptyTotals();
    const connections = new Map<string, UsageConnectionTotal>(), models = new Map<string, UsageModelTotal>();
    const dates = new Map<string, UsageDay>();
    for (let offset = 29; offset >= 0; offset--) {
      const date = shanghaiDate(new Date(now.getTime() - offset * 86400000)); dates.set(date, { ...emptyTotals(), date });
    }
    for (const row of this.rows) {
      const rowDay = shanghaiDate(new Date(row.finishedAt));
      const daily = dates.get(rowDay); if (daily) add(daily, row);
      if (rowDay === day) add(today, row);
      if (rowDay.slice(0, 7) !== monthKey) continue;
      add(month, row);
      let connection = connections.get(row.connectionId);
      if (!connection) { connection = { ...emptyTotals(), connectionId: row.connectionId, name: row.connectionName, model: row.model, engine: row.engine }; connections.set(row.connectionId, connection); } add(connection, row);
      let model = models.get(row.model);
      if (!model) { model = { ...emptyTotals(), model: row.model }; models.set(row.model, model); } add(model, row);
    }
    const ordered = <T extends UsageTotals>(map: Map<string, T>): T[] => [...map.values()].sort((a, b) => b.knownCostCNY - a.knownCostCNY || b.requestCount - a.requestCount);
    return structuredClone({ timezone: 'Asia/Shanghai', today, month, daily: [...dates.values()], byConnection: ordered(connections), byModel: ordered(models),
      records: this.records({}, now), startedAt: this.rows[0]?.startedAt ?? null });
  }
}
