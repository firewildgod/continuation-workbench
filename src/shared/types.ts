import type { UsagePricing, UsageQuery, UsageRecord, UsageSummary, OfficialPricingRefreshInput, OfficialPricingRefreshReport } from './usage';
export type { UsagePricing, UsageQuery, UsageRecord, UsageSummary, UsageTokens, UsageTotals, OfficialPricingTarget, OfficialPricingResult, OfficialPricingRefreshInput, OfficialPricingRefreshReport } from './usage';
export type Engine = 'codex' | 'claude';
export type AuthMode = 'subscription' | 'api';
export type Protocol = 'responses' | 'anthropic' | 'chat-completions';
export interface ProviderPreset {
  id: string; name: string; description: string;
  baseUrls: Partial<Record<Protocol, string>>;
  models: string[]; protocols: Protocol[];
  website: string; purchaseUrl: string; docsUrl: string;
  compatibility: string; note?: string;
}
export interface Connection {
  id: string; name: string; presetId: string; engine: Engine;
  baseUrl: string; model: string; protocol: Protocol;
  hasKey: boolean; maskedKey?: string; testedAt?: string;
  testStatus?: 'untested' | 'auth-ok' | 'passed' | 'failed';
  testMessage?: string;
  pricing?: UsagePricing;
  pricingMode?: 'official' | 'manual';
}
export interface ConnectionInput {
  id?: string; name: string; presetId: string; engine: Engine;
  baseUrl: string; model: string; protocol: Protocol;
  apiKey?: string;
  pricing?: UsagePricing;
}
export interface Project { id: string; name: string; path: string; createdAt: string; }
export interface Settings {
  monthlyBudgetCNY: number;
  codexPath: string; claudePath: string;
  fallbackConnectionId?: string;
  autoFallback: boolean;
  codexDesktopPath?: string; codexConfigPath?: string; claudeConfigPath?: string;
  claudeLaunchDirectory?: string;
  claudeDesktopPath?: string; claudeDesktopConfigDir?: string;
}
export interface RuntimeDiagnostic {
  engine: Engine; available: boolean; path: string; version?: string; message: string;
}
export interface TestResult { ok: boolean; status: 'auth-ok' | 'passed' | 'failed'; message: string; elapsedMs: number; }
export interface SessionInfo {
  id: string; engine: Engine; projectId: string; projectPath: string;
  authMode: AuthMode; connectionId?: string; providerName: string;
  model: string; nativeSessionId?: string;
  status: 'starting' | 'ready' | 'running' | 'waiting' | 'quota' | 'stopped' | 'error';
  startedAt: string; lastPrompt?: string; summary?: string;
}
export interface FileChange { path: string; status: string; }
export interface Checkpoint {
  id: string; sessionId: string; nativeSessionId?: string;
  engine: Engine; projectId: string; projectPath: string;
  authMode: AuthMode; connectionId?: string; model: string;
  createdAt: string; prompt: string; summary: string;
  changes: FileChange[]; pendingOperation?: string;
}
export interface AppState {
  projects: Project[]; connections: Connection[]; presets: ProviderPreset[];
  settings: Settings; diagnostics: RuntimeDiagnostic[];
  sessions: SessionInfo[]; checkpoints: Checkpoint[]; dataDir: string;
  companion?: CompanionState;
}
export interface ToolStatus {
  engine: Engine; configPath: string; executablePath: string; configExists: boolean;
  running: boolean; mode: 'api' | 'subscription' | 'unknown'; activeConnectionId?: string;
  message: string;
}
export interface GatewayStatus {
  running: boolean; baseUrl: string; port: number; activeRequests: number;
  routes: { codex?: string; claude?: string; claudeDesktop?: string }; requestCounts: { codex: number; claude: number; claudeDesktop?: number };
  lastDesktopRequestAt?: string; desktopSuccessCount?: number; lastDesktopModel?: string;
  lastError?: string;
}
export interface ConfigBackupInfo {
  id: string; engine: Engine; configPath: string; createdAt: string; label: string; canRestore: boolean;
}
export type ClaudeGuiActivation = 'unconfigured' | 'prepared' | 'configured' | 'verified' | 'external' | 'unknown';
export interface ClaudeGuiStatus {
  executablePath: string; running: boolean; configPath: string; configExists: boolean;
  mode: 'api' | 'subscription' | 'unknown'; activationState: ClaudeGuiActivation;
  activationKind: 'auto' | 'manual-import'; activeConnectionId?: string; model?: string;
  gatewayBaseUrl?: string; message: string; lastRequestAt?: string; requestCount?: number;
  backups: ConfigBackupInfo[]; policyManaged?: boolean;
  connectionIssues?: Record<string, string>; compatibilityNote?: string;
  clientVersion?: string;
}
export interface ClaudeGuiConfigInput { mode: AuthMode; connectionId?: string; }
export interface ClaudeGuiConfigPreview extends ConfigPreview {
  surface: 'desktop'; activationKind: 'auto' | 'manual-import'; previewId?: string;
}
export interface ClaudeGuiConfigResult extends ConfigResult {
  activationState?: ClaudeGuiActivation; exportPath?: string;
}
export interface CompanionState { tools: ToolStatus[]; gateway: GatewayStatus; backups: ConfigBackupInfo[]; claudeDesktop?: ClaudeGuiStatus; }
export interface ToolConfigInput { engine: Engine; mode: AuthMode; connectionId?: string; }
export interface ConfigPreview {
  engine: Engine; mode: AuthMode; configPath: string; before: string; after: string;
  warnings: string[]; changed: boolean;
}
export interface ConfigResult { ok: boolean; message: string; restartRequired: boolean; backupId?: string; }
export interface EngineEvent {
  type: 'status' | 'log' | 'delta' | 'terminal' | 'quota' | 'approval' | 'auth' | 'session' | 'tool' | 'error';
  sessionId: string; engine: Engine; message?: string; data?: unknown;
}
export interface StartSessionInput {
  engine: Engine; projectId: string; authMode: AuthMode;
  connectionId?: string; prompt?: string; resumeSessionId?: string;
}
export interface RestoreInput {
  checkpointId: string; connectionId?: string; engine?: Engine;
  mode: 'native' | 'summary';
}
export interface DesktopExport { path: string; message: string; }
export interface DesktopAPI {
  getUsageSummary(): Promise<UsageSummary>;
  getUsageRecords(query?: UsageQuery): Promise<UsageRecord[]>;
  savePricing(input: { connectionId: string; pricing: UsagePricing | null }): Promise<Connection>;
  refreshOfficialPricing(input?: OfficialPricingRefreshInput): Promise<OfficialPricingRefreshReport>;
  exportUsageReport(): Promise<DesktopExport>;
  getState(): Promise<AppState>;
  getToolState(): Promise<CompanionState>;
  previewToolConfig(input: ToolConfigInput): Promise<ConfigPreview>;
  applyToolConfig(input: ToolConfigInput): Promise<ConfigResult>;
  switchRoute(input: {engine: Engine; connectionId: string}): Promise<ConfigResult>;
  launchTool(input: {engine: Engine; directory?: string}): Promise<ConfigResult>;
  restoreConfigBackup(id: string): Promise<ConfigResult>;
  openConfigFolder(engine: Engine): Promise<void>;
  chooseFolder(): Promise<string | null>;
  chooseExecutable(): Promise<string | null>;
  addProject(input: {name: string; path: string}): Promise<Project>;
  removeProject(id: string): Promise<void>;
  saveConnection(input: ConnectionInput): Promise<Connection>;
  deleteConnection(id: string): Promise<void>;
  testConnection(id: string): Promise<TestResult>;
  saveSettings(input: Partial<Settings>): Promise<Settings>;
  diagnose(): Promise<RuntimeDiagnostic[]>;
  startSession(input: StartSessionInput): Promise<SessionInfo>;
  sendPrompt(input: {sessionId: string; text: string}): Promise<void>;
  interruptSession(id: string): Promise<void>;
  stopSession(id: string): Promise<void>;
  terminalInput(input: {sessionId: string; data: string}): Promise<void>;
  terminalResize(input: {sessionId: string; cols: number; rows: number}): Promise<void>;
  approveRequest(input: {sessionId: string; requestId: string | number; decision: string}): Promise<void>;
  saveCheckpoint(sessionId: string): Promise<Checkpoint>;
  restoreCheckpoint(input: RestoreInput): Promise<SessionInfo>;
  login(engine: Engine): Promise<void>;
  openExternal(url: string): Promise<void>;
  openProject(id: string): Promise<void>;
  exportDesktopConfig(connectionId: string): Promise<DesktopExport>;
  exportBackup(): Promise<DesktopExport>;
  exportVSCodeConfig(connectionId: string): Promise<DesktopExport>;
  getClaudeDesktopState(): Promise<ClaudeGuiStatus>;
  previewClaudeDesktopConfig(input: ClaudeGuiConfigInput): Promise<ClaudeGuiConfigPreview>;
  applyClaudeDesktopConfig(input: ClaudeGuiConfigInput): Promise<ClaudeGuiConfigResult>;
  restoreClaudeDesktopConfigBackup(id?: string): Promise<ClaudeGuiConfigResult>;
  launchClaudeDesktop(): Promise<ConfigResult>;
  openClaudeDesktopConfigFolder(): Promise<void>;
  onEvent(callback: (event: EngineEvent) => void): () => void;
}
declare global { interface Window { desktop: DesktopAPI; } }
