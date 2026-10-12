import http, { type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Connection, Engine, GatewayStatus } from '../shared/types';
import { UsageObserver, validateUsagePricing } from './usage';
import type { UsageCapture } from '../shared/usage';

/** Routes are independent surfaces; billing keeps the existing Engine values. */
export type GatewayRoute = Engine | 'claudeDesktop';

export interface GatewayOptions {
  token: string; port: number;
  getConnection: (id: string) => Connection | undefined;
  getSecret: (id: string) => string | undefined;
  onChange?: (status: GatewayStatus) => void;
  onUsage?: (capture: UsageCapture) => void;
}
export class LocalGateway {
  private server?: Server;
  private routes: Partial<Record<GatewayRoute, string>> = {};
  private counts = { codex: 0, claude: 0, claudeDesktop: 0 };
  private pending: Record<GatewayRoute, number> = { codex: 0, claude: 0, claudeDesktop: 0 };
  private actualPort: number;
  private paused = new Set<GatewayRoute>();
  private lastError?: string;
  private lastDesktopRequestAt?: string;
  private desktopSuccessCount = 0;
  private lastDesktopModel?: string;
  private handlers = new Set<Promise<void>>();
  constructor(private options: GatewayOptions) {
    if (options.token.length < 32) throw new Error('本机网关令牌长度不足。');
    this.actualPort = options.port;
  }
  status(): GatewayStatus {
    return { running: Boolean(this.server?.listening), baseUrl: `http://127.0.0.1:${this.actualPort}`,
      port: this.actualPort, activeRequests: this.pending.codex + this.pending.claude + this.pending.claudeDesktop,
      routes: {...this.routes}, requestCounts: {...this.counts}, lastError: this.lastError,
      lastDesktopRequestAt: this.lastDesktopRequestAt, desktopSuccessCount: this.desktopSuccessCount, lastDesktopModel: this.lastDesktopModel };
  }
  activeRequestsFor(route: GatewayRoute): number { return this.pending[route]; }
  private notify(): void { this.options.onChange?.(this.status()); }
  setRoute(route: GatewayRoute, id: string): void {
    const engine: Engine = route === 'claudeDesktop' ? 'claude' : route;
    const connection = this.options.getConnection(id);
    if (!connection || connection.engine !== engine) throw new Error('连接与工作台不匹配。');
    if ((engine === 'codex' && connection.protocol !== 'responses') || (engine === 'claude' && connection.protocol !== 'anthropic')) throw new Error('接口协议与工作台不兼容。');
    if (!this.options.getSecret(id)) throw new Error('请先填写可用的 API 密钥。');
    if (this.pending[route]) throw new Error('该工作台还有请求执行中，请停止任务或等待请求结束后再切换。');
    if (route === 'claudeDesktop' && this.routes[route] !== id) this.resetDesktopVerification();
    this.routes[route] = id; this.lastError = undefined; this.notify();
  }
  clearRoute(route: GatewayRoute): void {
    if (this.pending[route]) throw new Error('该工作台还有请求执行中，请停止任务或等待请求结束后再切换。');
    delete this.routes[route]; if (route === 'claudeDesktop') this.resetDesktopVerification(); this.notify();
  }
  pause(route: GatewayRoute): void { if(this.pending[route])throw new Error('仍有请求执行中，请等待完成。');this.paused.add(route); }
  resume(route: GatewayRoute): void { this.paused.delete(route); }
  private resetDesktopVerification(): void { this.lastDesktopRequestAt = undefined; this.desktopSuccessCount = 0; this.lastDesktopModel = undefined; }
  async start(): Promise<void> {
    if (this.server?.listening) return;
    const server = http.createServer((request, response) => {
      const task = this.handle(request, response); this.handlers.add(task);
      void task.then(() => this.handlers.delete(task), () => this.handlers.delete(task));
    });
    server.requestTimeout = 0; server.headersTimeout = 30_000;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    }).catch(error => { this.server = undefined; throw error; });
    const address = server.address(); if (address && typeof address !== 'string') this.actualPort = address.port;
    this.notify();
  }
  async stop(): Promise<void> {
    const server = this.server; if (!server) return;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    // HTTP server closure precedes async fetch/stream cancellation. Drain those
    // callbacks before the caller flushes the ledger and exits the application.
    await Promise.allSettled([...this.handlers]);
    this.server = undefined; this.notify();
  }
  private authorized(request: http.IncomingMessage): boolean {
    const auth = request.headers.authorization?.replace(/^Bearer\s+/i, '') || request.headers['x-api-key'];
    if (typeof auth !== 'string' || request.headers.origin) return false;
    const candidate = Buffer.from(auth), expected = Buffer.from(this.options.token);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }
  private failure(response: http.ServerResponse, status: number, message: string): void {
    if (response.headersSent) { response.destroy(); return; }
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }));
  }
  private desktopModels(url: URL, suffix: string, connection: Connection, response: http.ServerResponse): void {
    const model = connection.model.replace(/\[1m\]$/, '');
    // These are routing metadata, not a claim about provider capabilities or a paid availability test.
    const info = { id: model, type: 'model', display_name: model, created_at: '1970-01-01T00:00:00Z' };
    let payload: unknown = info;
    if (suffix === '/v1/models') {
      const keys = [...url.searchParams.keys()];
      if (keys.some(key => !['limit', 'after_id', 'before_id', 'beta'].includes(key))
        || keys.some(key => url.searchParams.getAll(key).length !== 1)
        || (url.searchParams.has('beta') && url.searchParams.get('beta') !== 'true')) {
        this.failure(response, 400, '模型目录查询参数无效。'); return;
      }
      const limit = url.searchParams.get('limit');
      if (limit !== null && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 1000)) {
        this.failure(response, 400, '模型目录每页数量应为 1 至 1000。'); return;
      }
      const after = url.searchParams.get('after_id'), before = url.searchParams.get('before_id');
      if ((after !== null && after !== model) || (before !== null && before !== model) || (after !== null && before !== null)) {
        this.failure(response, 400, '模型目录分页标记无效。'); return;
      }
      const data = after !== null || before !== null ? [] : [info];
      payload = { data, has_more: false, first_id: data.length ? model : null, last_id: data.length ? model : null };
    } else {
      if (url.search && url.search !== '?beta=true') { this.failure(response, 400, '该查询参数未开放。'); return; }
      let requested: string;
      try { requested = decodeURIComponent(suffix.slice('/v1/models/'.length)); }
      catch { this.failure(response, 400, '模型 ID 无效。'); return; }
      if (requested !== model) { this.failure(response, 404, '该模型未配置为 Claude 桌面连接。'); return; }
    }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(payload));
  }
  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!this.authorized(request)) { this.failure(response, 401, '本机网关鉴权失败。'); return; }
    let url: URL;
    try { url = new URL(request.url || '/', 'http://127.0.0.1'); } catch { this.failure(response, 400, '请求地址无效。'); return; }
    const match = url.pathname.match(/^\/(codex|claude|claude-desktop)(\/.*)$/);
    if (!match) { this.failure(response, 404, '未知工作台接口。'); return; }
    const route: GatewayRoute = match[1] === 'claude-desktop' ? 'claudeDesktop' : match[1] as Engine;
    const engine: Engine = route === 'claudeDesktop' ? 'claude' : route, suffix = match[2];
    const desktopCatalog = route === 'claudeDesktop' && /^\/v1\/models(?:\/[^/]+)?$/.test(suffix);
    if (!desktopCatalog && url.search && !(engine==='claude' && url.search==='?beta=true')) { this.failure(response, 400, '该查询参数未开放。'); return; }
    if(this.paused.has(route)){this.failure(response,503,'正在切换本机配置，请完成后再发送请求。');return;}
    const permitted = engine === 'codex' ? /^\/v1\/(responses(?:\/compact)?|models)$/
      : route === 'claudeDesktop' ? /^\/v1\/(messages(?:\/count_tokens)?|models(?:\/[^/]+)?)$/ : /^\/v1\/(messages(?:\/count_tokens)?|models)$/;
    if (!permitted.test(suffix) || !['GET', 'POST'].includes(request.method || '')) { this.failure(response, 404, '该接口未开放。'); return; }
    if ((request.method === 'GET') !== (desktopCatalog || suffix.endsWith('/models'))) { this.failure(response, 405, '请求方法不匹配。'); return; }
    const id = this.routes[route], connection = id ? this.options.getConnection(id) : undefined;
    if (!connection || connection.engine !== engine || connection.protocol !== (engine === 'codex' ? 'responses' : 'anthropic')) {
      this.failure(response, 503, '请在 API 管理器中选择协议匹配的连接。'); return;
    }
    if (desktopCatalog) { this.desktopModels(url, suffix, connection, response); return; }
    const secret = id ? this.options.getSecret(id) : undefined;
    if (!secret) { this.failure(response, 503, '请在 API 管理器中选择连接并填写密钥。'); return; }
    const pricing = validateUsagePricing(connection.pricing);
    const aborter = new AbortController();
    const timer = setTimeout(() => aborter.abort(), 10 * 60 * 1000);
    let clientCancelled = false;
    response.once('close', () => { if (!response.writableEnded) { clientCancelled = true; aborter.abort(); } });
    const startedAt = new Date().toISOString();
    let observer: UsageObserver | undefined, upstreamStatus = 0, reachedUpstream = false, transportComplete = false;
    const billable = request.method === 'POST' && !suffix.endsWith('/count_tokens');
    this.pending[route]++; this.counts[engine]++; if (route === 'claudeDesktop') this.counts.claudeDesktop++; this.notify();
    try {
      let body: string | undefined;
      if (request.method === 'POST') {
        const chunks: Buffer[] = []; let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 64 * 1024 * 1024) { this.failure(response, 413, '请求超过 64 MiB。'); return; }
          chunks.push(Buffer.from(chunk));
        }
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { this.failure(response, 400, '请求体必须为 JSON。'); return; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { this.failure(response, 400, '请求体必须为 JSON 对象。'); return; }
        parsed.model = connection.model.replace(/\[1m\]$/, '');
        body = JSON.stringify(parsed);
      }
      const base = new URL(connection.baseUrl);
      const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
      if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) throw new Error('上游地址必须使用 HTTPS。');
      if (loopback && Number(base.port) === this.actualPort) throw new Error('不能把上游指向网关自身。');
      const relative = engine === 'codex' ? suffix.replace(/^\/v1\//, '/') : /\/v1\/?$/.test(base.pathname) ? suffix.replace(/^\/v1\//, '/') : suffix;
      const target = connection.baseUrl.replace(/\/+$/, '') + relative + url.search;
      const headers: Record<string, string> = { 'content-type': 'application/json', 'authorization': `Bearer ${secret}`, accept: String(request.headers.accept || 'application/json') };
      for(const [name,value] of Object.entries(request.headers)) {
        if(typeof value==='string'&&(name==='user-agent'||/^x-stainless-(lang|package-version|os|arch|runtime|runtime-version|retry-count|timeout)$/.test(name)))headers[name]=value;
      }
      if (engine === 'claude') { headers['x-api-key'] = secret; headers['anthropic-version'] = String(request.headers['anthropic-version'] || '2023-06-01'); }
      if (typeof request.headers['anthropic-beta'] === 'string') headers['anthropic-beta'] = request.headers['anthropic-beta'];
      reachedUpstream = true;
      const upstream = await fetch(target, { method: request.method, headers, body, signal: aborter.signal, redirect: 'error' });
      upstreamStatus = upstream.status;
      if (billable && (this.options.onUsage || route === 'claudeDesktop')) observer = new UsageObserver(connection.protocol, upstream.headers.get('content-type') || '');
      const outbound: Record<string, string> = { 'cache-control': 'no-store' };
      for (const key of ['content-type', 'retry-after', 'request-id', 'x-request-id']) { const value = upstream.headers.get(key); if (value) outbound[key] = value; }
      response.writeHead(upstream.status, outbound);
      if (!upstream.ok) { this.lastError = `${engine === 'codex' ? 'Codex' : route === 'claudeDesktop' ? 'Claude 桌面' : 'Claude Code'} 上游 HTTP ${upstream.status}，请检查余额、限流和接口权限。`; this.notify(); }
      if (upstream.body) {
        await new Promise<void>((resolve, reject) => {
          const stream = Readable.fromWeb(upstream.body as any);
          // Observing whitelisted usage metadata keeps normal pipe backpressure and chunk timing.
          // Malformed accounting metadata must never turn a working response into a gateway failure.
          if (observer) stream.on('data', chunk => { try { observer!.write(chunk); } catch { /* Unknown usage is safe to report. */ } });
          stream.once('end', () => { transportComplete = true; });
          stream.on('error', reject); response.on('error', reject);
          response.once('close', resolve); response.once('finish', resolve);
          stream.pipe(response);
        });
      } else { transportComplete = true; response.end(); }
    } catch (error) {
      // Only status enters manager logs; never persist request bodies, responses, keys or prompts.
      this.lastError = '网关请求失败，请检查网络、上游端点或客户端是否取消。'; this.notify();
      this.failure(response, 502, this.lastError);
    } finally {
      clearTimeout(timer);
      let observed: ReturnType<UsageObserver['finish']> | undefined;
      try { observed = observer?.finish(transportComplete); } catch { /* Unknown usage cannot break routing. */ }
      const outcome: UsageCapture['outcome'] = clientCancelled ? 'cancelled' : transportComplete && upstreamStatus >= 200 && upstreamStatus < 300 && !observed?.failed ? 'success' : 'error';
      if (route === 'claudeDesktop' && billable && reachedUpstream && outcome === 'success' && observed?.complete && observed.tokens) {
        this.desktopSuccessCount++; this.lastDesktopRequestAt = new Date().toISOString();
        // Bind verification to the configured request model. Providers may resolve
        // its alias to a snapshot ID; the ledger separately keeps that reported ID.
        this.lastDesktopModel = connection.model;
      }
      if (billable && reachedUpstream && this.options.onUsage) {
        try {
          this.options.onUsage({ connectionId: connection.id, connectionName: connection.name, engine,
            model: observed?.model || connection.model.replace(/\[1m\]$/, ''), startedAt, finishedAt: new Date().toISOString(),
            httpStatus: upstreamStatus, outcome, surface: engine === 'claude' ? route === 'claudeDesktop' ? 'desktop' : 'cli' : undefined,
            tokens: observed?.complete ? observed.tokens ?? null : null, kind: 'request', pricing });
        } catch { /* Accounting callbacks cannot interrupt a forwarded response. */ }
      }
      this.pending[route]--; this.notify();
    }
  }
}
