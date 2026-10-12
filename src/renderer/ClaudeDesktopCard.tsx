import type { ClaudeGuiConfigResult, ClaudeGuiStatus, Connection, GatewayStatus } from '../shared/types';
import { Button, Field, Pill } from './components';
import { Icon } from './Icon';

type DesktopChoice = { mode: 'subscription' | 'api'; connectionId: string };
const ACTIVATION_LABELS = { unconfigured: '原配置', prepared: '待导入', configured: '待验证', verified: '已验证', external: '外部配置', unknown: '未确认' };
const TEST_LABELS = { untested: '未测试', 'auth-ok': '认证通过', passed: '连接可用', failed: '连接失败' };

export function ClaudeDesktopCard({ status, choice, connections, gateway, busy, result, onChoice, onPreview, onLaunch, onRestore, onAddConnection, onEditConnection, onChooseProgram, onOpenFolder, onUsage, onDocs, onUseTerminal }: {
  status?: ClaudeGuiStatus; choice: DesktopChoice; connections: Connection[]; gateway?: GatewayStatus; busy: boolean; result?: ClaudeGuiConfigResult;
  onChoice: (change: Partial<DesktopChoice>) => void; onPreview: () => void; onLaunch: () => void; onRestore: (id: string) => void;
  onAddConnection: () => void; onEditConnection: (connection: Connection) => void; onChooseProgram: () => void; onOpenFolder: () => void; onUsage: () => void; onDocs: () => void;
  onUseTerminal: (connection: Connection) => void;
}) {
  const supported = connections.filter(item => item.engine === 'claude' && item.protocol === 'anthropic');
  const selected = supported.find(item => item.id === choice.connectionId);
  const current = connections.find(item => item.id === status?.activeConnectionId);
  const backup = status?.backups.filter(item => item.canRestore).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const activation = status?.activationState || 'unknown';
  const manualImport = status?.activationKind === 'manual-import';
  const connectionIssue = choice.mode === 'api' && selected ? status?.connectionIssues?.[selected.id] : undefined;
  const showSteps = !connectionIssue && (choice.mode === 'api' || status?.mode === 'api' || activation === 'prepared');
  return <section className="panel connector-card claude-desktop-card" aria-label="Claude 桌面连接">
    <div className="connector-heading"><div className="tool-mark claude"><Icon name="desktop" /></div><div className="connector-title"><h2>Claude Desktop</h2><span>图形工作台 · Code</span></div><Pill tone={status?.running ? 'success' : status?.executablePath ? '' : 'warning'}>{status ? status.running ? '运行中' : status.executablePath ? '已安装' : '未找到程序' : '未检测'}</Pill></div>
    <div className="connector-content">
      <div className={`current-route ${status?.mode === 'api' ? 'api-route' : ''}`}><span className="section-label">桌面 Code 接入</span><div className="route-title"><strong>{activation === 'external' ? '由其他配置管理' : status?.mode === 'api' ? current?.name || '外部 API' : status?.mode === 'unknown' ? '配置待确认' : status ? '官方账号 / 原配置' : '等待本机检测'}</strong><Pill tone={activation === 'verified' ? 'success' : activation === 'prepared' || activation === 'configured' || activation === 'unknown' ? 'warning' : ''}>{activation === 'prepared' && !manualImport ? '待启用' : ACTIVATION_LABELS[activation]}</Pill></div>{status?.mode === 'api' && <span className="desktop-current-model">{current?.model || status.model || '模型待确认'}</span>}<p>{status?.message || '打开桌面版后自动检测 Claude 图形工作台。'}</p></div>
      <div className="form-grid tool-choice"><Field label="桌面使用方式"><select value={choice.mode} onChange={event => onChoice({ mode: event.target.value as DesktopChoice['mode'] })}><option value="subscription">官方账号 / 原配置</option><option value="api">外部 API</option></select></Field><Field label="桌面 API 连接"><select disabled={choice.mode === 'subscription'} value={choice.connectionId} onChange={event => onChoice({ connectionId: event.target.value })}><option value="">{choice.mode === 'subscription' ? '使用官方配置' : '选择 Anthropic 连接'}</option>{supported.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}{status?.connectionIssues?.[item.id] ? '（当前桌面不支持）' : ''}</option>)}</select></Field></div>
      {choice.mode === 'api' && !supported.length && <div className="inline-callout"><span>还没有 Anthropic Messages 连接</span><Button tone="ghost" icon="plus" onClick={onAddConnection}>添加</Button></div>}
      {choice.mode === 'api' && selected && <div className="connection-meta"><Pill tone={selected.testStatus === 'passed' || selected.testStatus === 'auth-ok' ? 'success' : selected.testStatus === 'failed' ? 'error' : ''}>{TEST_LABELS[selected.testStatus || 'untested']}</Pill><code>Anthropic Messages</code>{selected.testStatus === 'failed' && <button className="text-button" onClick={() => onEditConnection(selected)}>修复连接</button>}</div>}
      {connectionIssue && selected && <div className="desktop-incompatible" role="status"><Icon name="info" /><div><strong>当前桌面版本不支持此模型</strong><p>{connectionIssue}</p><Button tone="soft" icon="terminal" disabled={busy} onClick={() => onUseTerminal(selected)}>前往终端 / VS Code 接入</Button></div></div>}
      <div className="connector-actions"><Button icon={manualImport ? 'external' : 'save'} tone="primary" disabled={busy || !status || (!manualImport && (!!connectionIssue || (choice.mode === 'api' && !selected?.hasKey)))} onClick={manualImport ? onDocs : onPreview}>{manualImport ? '官方配置指引' : '预览并应用'}</Button><Button icon="desktop" disabled={busy || !status?.executablePath} onClick={onLaunch}>{status?.running ? '切回桌面' : '打开桌面'}</Button><Button icon="restore" tone="ghost" disabled={busy || !backup} onClick={() => backup && onRestore(backup.id)}>恢复</Button></div>
      {manualImport && <p className="helper-text">当前桌面版本尚未核实自动适配，请使用官方配置窗口。此入口打开操作说明，不会生成或应用接入配置。</p>}
      {status?.compatibilityNote && !connectionIssue && <p className="helper-text desktop-compatibility-note">{status.compatibilityNote}</p>}
      {showSteps && <div className="desktop-next-step"><Icon name={activation === 'verified' ? 'check' : 'info'} /><div><strong>{activation === 'verified' ? '桌面请求已通过本机网关' : activation === 'prepared' ? manualImport ? '下一步：在桌面导入配置' : '桌面配置尚未启用' : activation === 'configured' ? '下一步：重启桌面并新建 Code 会话' : manualImport ? '导入后再验证桌面请求' : '应用后重启桌面并验证请求'}</strong><p>{activation === 'verified' ? '后续经过网关的请求会计入用量与费用。' : activation === 'prepared' ? manualImport ? '完成桌面导入后，发送一次新请求确认网关记录。' : '重新应用配置，或在桌面选择续航台的第三方推理配置，再发送新的 Code 请求。' : '保存当前工作，完全退出 Claude Desktop 后重新打开，在 Code 页发送新请求。'}{!gateway?.running && ' 请保持续航台网关运行。'}</p>{activation === 'verified' && <button className="text-button" onClick={onUsage}>查看费用<Icon name="arrow" /></button>}</div></div>}
      {!!status?.requestCount && <div className="desktop-request-meta"><span>桌面网关请求 <strong>{status.requestCount}</strong></span>{status.lastRequestAt && <span>最近 {new Date(status.lastRequestAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>}</div>}
      {result && !(result.ok && activation === 'verified') && <div className={`action-result ${result.ok ? '' : 'error'}`} role="status"><Icon name={result.ok ? 'check' : 'info'} /><span>{result.message}{result.restartRequired && ' 保存工作后，请退出并重新启动桌面。'}{result.exportPath && <code className="desktop-export-path">{result.exportPath}</code>}</span></div>}
      <details className="tool-details"><summary>桌面路径与接入说明<Icon name="chevron" /></summary><div className="path-row"><span>程序</span><code title={status?.executablePath}>{status?.executablePath || '尚未定位'}</code><Button icon="folder" tone="ghost" aria-label="选择 Claude 桌面程序" disabled={busy} onClick={onChooseProgram} /></div><div className="path-row"><span>配置</span><code title={status?.configPath}>{status?.configPath || '等待检测'}</code><Button icon="external" tone="ghost" aria-label="打开 Claude 桌面配置目录" disabled={busy || !status} onClick={onOpenFolder} /></div><p className="helper-text">仅连接 Claude 桌面的 Code 工作台。普通聊天、Cowork 和 Claude Code 终端各自管理配置；桌面与终端可选择不同连接。</p><button className="text-button" onClick={onDocs}>官方桌面接入说明<Icon name="external" /></button></details>
    </div>
  </section>;
}
