import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { quotePowerShellArgument } from './services';

const execute = promisify(execFile);
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export interface DesktopDetection { codexPath: string; codexRunning: boolean; claudeRunning: boolean; appId?: string; claudeDesktopPath?: string; claudeDesktopRunning?: boolean; claudeDesktopAppId?: string; claudeDesktopVersion?: string; }
export interface ToolLaunchResult { action: 'activated' | 'opened'; message: string; pid?: number; }
export function isClaudeCodeCliProcess(process: { Name?: string; ExecutablePath?: string }): boolean {
  if (process.Name?.toLowerCase() !== 'claude.exe' || !process.ExecutablePath) return false;
  const executable = process.ExecutablePath.replace(/\//g, '\\');
  // The desktop app shares the name Claude.exe. A process name alone cannot
  // establish that the terminal CLI is running; inaccessible paths stay unknown.
  if (/\\WindowsApps\\|\\Claude(?: Desktop|-3p)?\\(?:app\\)?Claude\.exe$/i.test(executable)) return false;
  return /\\node_modules\\@anthropic-ai\\claude-code(?:-[^\\]+)?\\(?:bin\\)?claude\.exe$/i.test(executable)
    || /\\\.local\\bin\\claude\.exe$/i.test(executable)
    || /\\\.claude\\local\\claude\.exe$/i.test(executable);
}
export function isClaudeGuiProcess(process: { Name?: string; ExecutablePath?: string }): boolean {
  if (process.Name?.toLowerCase() !== 'claude.exe' || !process.ExecutablePath || isClaudeCodeCliProcess(process)) return false;
  const executable = process.ExecutablePath.replace(/\//g, '\\');
  return /\\WindowsApps\\Claude_[^\\]+\\app\\claude\.exe$/i.test(executable)
    || /\\(?:Programs\\)?Claude(?: Desktop)?\\(?:app-[^\\]+\\)?claude\.exe$/i.test(executable);
}
const encodeScript = (script: string): string => Buffer.from(script,'utf16le').toString('base64');
async function runPowerShell(script: string): Promise<string> {
  const result=await execute(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encodeScript(script)],{windowsHide:true,timeout:15_000,maxBuffer:256*1024});
  return result.stdout.trim();
}
export function codexActivationScript(executable: string): string {
  return `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WorkbenchWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hwnd, int show);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public static bool IsForeground(uint processId) {
    uint owner; GetWindowThreadProcessId(GetForegroundWindow(),out owner); return owner==processId;
  }
  public static bool Activate(IntPtr hwnd,uint processId) {
    uint owner; uint foreground=GetWindowThreadProcessId(GetForegroundWindow(),out owner);
    uint target=GetWindowThreadProcessId(hwnd,out owner), current=GetCurrentThreadId();
    bool joinForeground=false,joinTarget=false;
    try {
      if(foreground!=0 && foreground!=current)joinForeground=AttachThreadInput(current,foreground,true);
      if(target!=0 && target!=current && target!=foreground)joinTarget=AttachThreadInput(current,target,true);
      ShowWindowAsync(hwnd,9);BringWindowToTop(hwnd);SetForegroundWindow(hwnd);
      return IsForeground(processId);
    } finally {
      if(joinTarget)AttachThreadInput(current,target,false);
      if(joinForeground)AttachThreadInput(current,foreground,false);
    }
  }
}
'@
$taskWindowProcess=Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ${quotePowerShellArgument(executable)} -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if($taskWindowProcess){
  [void][WorkbenchWindow]::Activate($taskWindowProcess.MainWindowHandle,[uint32]$taskWindowProcess.Id)
  if(-not [WorkbenchWindow]::IsForeground([uint32]$taskWindowProcess.Id)){
    $taskWindowShell=New-Object -ComObject WScript.Shell
    [void]$taskWindowShell.AppActivate($taskWindowProcess.Id)
  }
  @{activated=([WorkbenchWindow]::IsForeground([uint32]$taskWindowProcess.Id));pid=$taskWindowProcess.Id}|ConvertTo-Json -Compress
}else{@{activated=$false}|ConvertTo-Json -Compress}`;
}
let cached: {time: number; result: DesktopDetection} | undefined;
export async function detectDesktops(force = false): Promise<DesktopDetection> {
  if (!force && cached && Date.now() - cached.time < 8_000) return cached.result;
  const script = `$p=@(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe' OR Name='Codex.exe' OR Name='claude.exe'" | Select-Object Name,ExecutablePath); $a=Get-AppxPackage OpenAI.Codex | Select-Object -First 1 InstallLocation,PackageFamilyName; $c=Get-AppxPackage Claude | Select-Object -First 1 InstallLocation,PackageFamilyName,@{Name='Version';Expression={$_.Version.ToString()}}; @{processes=$p;package=$a;claudePackage=$c}|ConvertTo-Json -Depth 4 -Compress`;
  let result: DesktopDetection = { codexPath: '', codexRunning: false, claudeRunning: false };
  try {
    const output = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {windowsHide:true,timeout:10_000});
    const info = JSON.parse(output.stdout.trim());
    const processes: {Name:string;ExecutablePath?:string}[] = Array.isArray(info.processes) ? info.processes : [];
    const desktop = processes.find(item => item.ExecutablePath && /OpenAI[.\\/]Codex|WindowsApps.*Codex/i.test(item.ExecutablePath) && /ChatGPT\.exe|[\\/]app[\\/]Codex\.exe/i.test(item.ExecutablePath));
    result.codexPath = desktop?.ExecutablePath || '';
    result.codexRunning = Boolean(desktop);
    result.claudeRunning = processes.some(isClaudeCodeCliProcess);
    const claudeGui = processes.find(isClaudeGuiProcess);
    result.claudeDesktopPath = claudeGui?.ExecutablePath || '';
    result.claudeDesktopRunning = Boolean(claudeGui);
    if (info.claudePackage?.InstallLocation) {
      result.claudeDesktopVersion = typeof info.claudePackage.Version === 'string' ? info.claudePackage.Version : undefined;
      const candidate = path.join(info.claudePackage.InstallLocation, 'app', 'claude.exe');
      if (!result.claudeDesktopPath && fs.existsSync(candidate)) result.claudeDesktopPath = candidate;
      const manifest = path.join(info.claudePackage.InstallLocation, 'AppxManifest.xml');
      if (fs.existsSync(manifest)) {
        const id = fs.readFileSync(manifest, 'utf8').match(/<Application\s+Id="([^"]+)"/i)?.[1];
        if (id) result.claudeDesktopAppId = `${info.claudePackage.PackageFamilyName}!${id}`;
      }
    }
    if (info.package?.InstallLocation) {
      const candidate = path.join(info.package.InstallLocation, 'app', 'ChatGPT.exe');
      if (!result.codexPath && fs.existsSync(candidate)) result.codexPath = candidate;
      const manifest = path.join(info.package.InstallLocation, 'AppxManifest.xml');
      if (fs.existsSync(manifest)) {
        const id = fs.readFileSync(manifest, 'utf8').match(/<Application\s+Id="([^"]+)"/i)?.[1];
        if (id) result.appId = `${info.package.PackageFamilyName}!${id}`;
      }
    }
  } catch { /* Manual executable selection remains available. */ }
  cached = {time:Date.now(),result}; return result;
}
export async function launchClaudeGui(executable: string): Promise<ToolLaunchResult> {
  const detected = await detectDesktops(true);
  if (detected.claudeDesktopAppId && (!executable || executable === detected.claudeDesktopPath)) {
    await execute('explorer.exe', [`shell:AppsFolder\\${detected.claudeDesktopAppId}`], { windowsHide: true, timeout: 8_000 });
    return { action: 'opened', message: detected.claudeDesktopRunning ? '已发送切回 Claude 桌面工作台的请求；若窗口没有置前，请点击任务栏中的 Claude。' : '已通过官方应用入口打开 Claude 桌面工作台。' };
  }
  if (!path.isAbsolute(executable) || !fs.existsSync(executable) || !/\.exe$/i.test(executable)) throw new Error('请在工具设置中选择官方 Claude 桌面程序；Claude Code 终端程序不能代替它。');
  if (isClaudeCodeCliProcess({ Name: path.basename(executable), ExecutablePath: executable }) || /\\(?:node_modules\\@anthropic-ai|\.claude\\local|\.local\\bin)\\/i.test(executable)) throw new Error('选中的是 Claude Code 终端程序，请选择 Claude 桌面应用。');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
  return { action: 'opened', message: '已打开 Claude 桌面工作台；当前任务由原应用保留。' };
}
export async function launchCodexDesktop(executable: string): Promise<ToolLaunchResult> {
  const detected = await detectDesktops(true);
  if (detected.codexRunning) {
    try{
      const result=JSON.parse(await runPowerShell(codexActivationScript(detected.codexPath)));
      if(result.activated)return {action:'activated',pid:result.pid,message:'已切回正在运行的 Codex 工作台，当前任务保留。'};
    }catch { /* Use the installed app's normal activation if foregrounding is restricted. */ }
  }
  if (detected.appId && (!executable || executable === detected.codexPath)) {
    try{await execute('explorer.exe', [`shell:AppsFolder\\${detected.appId}`], {windowsHide:true,timeout:8_000});}
    catch{
      if(!(await detectDesktops(true)).codexRunning)throw new Error('官方 Codex 应用入口未能启动，请检查程序路径。');
      return {action:'opened',message:'Codex 窗口已恢复，Windows 未确认自动置前。请点击任务栏中的 Codex；无需关闭当前任务。'};
    }
    return {action:'opened',message:detected.codexRunning?'已通过官方应用入口唤起 Codex；若系统没有将它置前，请点击任务栏的 Codex。':'已通过官方入口打开 Codex 桌面。'};
  }
  if (!path.isAbsolute(executable) || !fs.existsSync(executable)) throw new Error('请先选择官方 Codex 桌面应用的 EXE；codex.exe 命令行程序不能代替桌面。');
  if (/codex\.exe$/i.test(executable) && !/[\\/]app[\\/]/i.test(executable)) throw new Error('这个路径是 Codex CLI，请选择 Codex 桌面程序。');
  await new Promise<void>((resolve, reject) => {
    const child=spawn(executable, [], {detached:true,stdio:'ignore',windowsHide:false});
    child.once('error',reject); child.once('spawn',()=>{child.unref();resolve();});
  });
  return {action:'opened',message:detected.codexRunning?'已发送 Codex 窗口唤起请求；请查看任务栏。':'已打开官方 Codex 桌面。'};
}
export function claudeTerminalScript(executable:string,directory:string,statusFile:string):string {
  return `$ErrorActionPreference='Stop'
function Write-LaunchStatus($taskPhase,$taskMessage=''){
  @{phase=$taskPhase;pid=$PID;message=$taskMessage}|ConvertTo-Json -Compress|Set-Content -LiteralPath ${quotePowerShellArgument(statusFile)} -Encoding UTF8
}
try{
  $host.UI.RawUI.WindowTitle='Claude Code'
  Set-Location -LiteralPath ${quotePowerShellArgument(directory)}
  if([Console]::IsInputRedirected -or [Console]::IsOutputRedirected){throw '终端未取得交互输入/输出句柄。'}
  Write-LaunchStatus 'ready'
  & ${quotePowerShellArgument(executable)}
  Write-LaunchStatus 'ended' ('Claude Code 已退出，退出码：'+$LASTEXITCODE)
}catch{
  Write-LaunchStatus 'failed' $_.Exception.Message
  Write-Host ('Claude Code 启动失败：'+$_.Exception.Message) -ForegroundColor Red
}`;
}
export async function launchClaudeTerminal(executable: string, directory: string, statusDir?:string): Promise<ToolLaunchResult> {
  if (!path.isAbsolute(executable) || !fs.existsSync(executable)) throw new Error('请先检测或选择官方 Claude Code 程序。');
  if (!path.isAbsolute(directory) || !fs.statSync(directory).isDirectory()) throw new Error('Claude Code 的工作目录不存在。');
  const folder=statusDir||path.join(os.tmpdir(),'continuation-workbench-launches');fs.mkdirSync(folder,{recursive:true});
  const statusFile=path.join(folder,`claude-${randomUUID()}.json`);
  const encoded=encodeScript(claudeTerminalScript(executable,directory,statusFile));
  const launcher=`$ErrorActionPreference='Stop'
$taskTerminal=Start-Process -FilePath ${quotePowerShellArgument(powershell)} -WorkingDirectory ${quotePowerShellArgument(directory)} -WindowStyle Normal -ArgumentList ${quotePowerShellArgument('-NoLogo -NoProfile -NoExit -EncodedCommand '+encoded)} -PassThru
@{pid=$taskTerminal.Id}|ConvertTo-Json -Compress`;
  let pid:number;
  try{pid=JSON.parse(await runPowerShell(launcher)).pid;}catch{throw new Error('无法创建 Claude Code 交互终端，请检查程序路径和系统终端设置。');}
  for(let attempt=0;attempt<48;attempt++){
    if(fs.existsSync(statusFile)){
      let record:{phase:string;pid:number;message?:string}|undefined;
      try{record=JSON.parse(fs.readFileSync(statusFile,'utf8').replace(/^\uFEFF/,''));}catch { /* File is still being written. */ }
      if(record?.phase==='failed')throw new Error(`Claude Code 终端启动失败：${record.message||'请查看新终端中的提示。'}`);
      if(record?.phase==='ended')throw new Error('Claude Code 已退出；交互终端已保留，请查看终端中的错误提示。');
      if(record?.phase==='ready')return {action:'opened',pid:record.pid,message:'已打开可交互的 Claude Code 终端；请在终端中继续操作。'};
    }
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw new Error(`终端启动状态尚未确认（进程 ${pid}）。请查看任务栏的 PowerShell/Windows Terminal；管理器没有停止或删除 Claude Code。`);
}
