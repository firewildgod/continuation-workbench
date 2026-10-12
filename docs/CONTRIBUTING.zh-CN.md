# 参与开发续航台

续航台通过本机网关和可恢复的用户配置连接官方工作台。改动需保持 Codex、Claude Code CLI、Claude Desktop 的独立路由，避免修改其它入口正在使用的连接。

项目公开仓库：[firewildgod/continuation-workbench](https://github.com/firewildgod/continuation-workbench)。程序包从 [GitHub Releases](https://github.com/firewildgod/continuation-workbench/releases/latest) 下载；普通用户参见 [安装与首次使用](INSTALL.zh-CN.md)。开发者在项目源码目录按以下流程构建。

## 开发环境与构建

准备 Windows x64、Node.js 22 与 npm。使用仓库的 `package-lock.json` 安装依赖，首次安装需要访问 npm 和 Electron 下载源；Electron 桌面打包需在相应 Windows 环境验证。

在项目根目录运行：

```powershell
npm ci
npm run typecheck
npm run build
npm test
```

开发过程中可用 `npm run dev:ui` 检查网页预览；网页预览不接管官方应用，也不代表真实 IPC 或文件配置已通过验收。`npm start` 打开 Electron 程序，首次开发运行应使用隔离测试目录。

```powershell
$env:WORKBENCH_TEST_DATA = Join-Path (Get-Location) '.qa\development'
npm start
```

`WORKBENCH_TEST_DATA` 隔离续航台自己的状态和加密库，**单独设置它不意味着所有官方工具路径已隔离**。测试配置中的 Codex 配置文件、Claude CLI 设置文件和 Claude Desktop `configLibrary` 都必须指向自己创建的 fixture；官方启动行为也应替换为测试桩。不要在空白开发状态下直接点击应用，误写当前用户的真实配置。

完成检查后生成 Windows 包：

```powershell
npm run package
node scripts/prepare-release.cjs
```

输出位于 `release`；发布准备脚本按明确文件清单生成 `续航台-<版本>-发布包` 和 `SHA256SUMS.txt`。更新功能后先同步版本、更新说明及用户文档，再构建。`dist` 是生成文件，不用手改。当前构建没有 Windows 代码签名，签名证书和私钥只能通过受控发布环境提供，不能提交到仓库。

## 目录与职责

| 目录 | 作用 |
| --- | --- |
| `src/main` | Electron 主进程、配置适配、加密存储、工具检测、本机网关和账本 |
| `src/main/preload.ts` | 向可信应用窗口提供明确的 IPC 方法 |
| `src/renderer` | React 界面与交互 |
| `src/shared` | 主进程与界面共用类型、用量与报价结构 |
| `tests` | 使用 fixture 的 Node 自动化测试 |
| `scripts` | 构建、发行准备与界面验收脚本 |
| `assets`、`docs` | 程序资源、用户说明和经过脱敏的公开截图 |

## 配置、权限与密钥边界

- 网关只监听 `127.0.0.1`，请求必须经过本机令牌鉴权。不能为了方便公开监听局域网、取消鉴权或让外部网页直接调用 IPC。
- 供应商 Key 只在主进程加密存储和请求转发时使用；公开状态、预览、错误和无密钥导出都不能泄露它。加密不可用时应停止保存或备份，不能静默改存明文。
- 修改官方工具配置必须经过预览、加密备份和文件状态校验。保留未知设置、hooks、权限和其它配置，遇到外部修改、未知格式、管理策略或不安全路径时停止写入并给出可操作提示。
- 不读取、导出或修改官方会员登录凭据；不向 Windows 注册表写企业策略，不绕过组织策略或模型兼容检查。
- 续航台不自动结束原工具进程。需要重启时说明如何保存工作、完全退出并重新打开；有在途请求时只拦截对应入口的路由修改。
- 原工具负责项目文件、会话与命令权限。不要默认禁用它的权限提示、启用无限自动执行，或用“顶级模式”误导用户认为所有模型都具有相同能力。
- Claude Desktop 的自动适配按实际版本核实。协议兼容、模型目录可访问与一次短请求成功，都不能代替官方客户端完整会话和文件任务验收；不通过把 Qwen 改名为 Claude 绕过限制。
- 费用记录不保存提示词、回答、项目文件或密钥。缺失用量、未知价格和缓存计费不确定时保留未知标记，不能记成零元。

## 测试与界面验收

`npm test` 执行 `tests/*.test.cjs`，相关测试直接读取和转译所需 TypeScript 源码；它不能代替完整的类型检查和发行构建。根据改动选择必要测试；涉及网关时验证真实 JSON/SSE 用量、取消、错误和工具调用透传，涉及配置时验证保留未知字段、备份恢复和外部修改保护。

开发验收使用可丢弃的 `.qa` 状态、模拟 Key、本机模拟上游和 fixture 配置；不应读写真实用户数据，也不应默认启动官方图形会话、发送付费模型请求。现有 Codex 离线目录测试会在检测到官方 CLI 时，用隔离 `CODEX_HOME` 启动短暂的 `app-server`，只校验配置和模型目录，不发模型请求；未安装相应 CLI 时会跳过。真实厂商验收需由有权限的用户单独执行，并在报告中区分模拟验证与真实 API 验证。

当前图形验收脚本的依赖情况：

- Playwright 已列入 `devDependencies`，`npm ci` 会安装项目锁定的版本。
- `scripts/smoke-packaged.cjs`、`scripts/smoke-desktop-ui.cjs` 和 `scripts/review-release-page.cjs` 使用 `require(process.env.PLAYWRIGHT_MODULE || 'playwright')`：默认加载项目依赖；需要使用另一个已安装模块时，可设置 `PLAYWRIGHT_MODULE` 为其模块路径。脚本不依赖原开发机器的用户目录。
- Electron 冒烟脚本通过独立调试端口连接自己启动的测试实例；下载页验收使用本机 Chrome，运行前需安装 Chrome。这些依赖只用于开发验收，不影响普通用户运行发行程序。
- `scripts/runtime-paths.cjs` 用于发现当前用户安装的 Claude Code CLI，支持 `CLAUDE_CODE_PATH` 指向自己的 `.cmd` 或 `.exe`；它不是 Playwright 或浏览器下载器。需要真实 CLI 的测试仍须另行安装官方工具。

验收脚本会占用独立调试与网关端口，应先确认端口未被占用；不能连接现有调试端口或关闭不属于当前验收的程序。截图必须标明本机模拟数据，清除个人路径、姓名、密钥和账单。模拟 Claude 模型 ID 只用于协议 fixture，不可写成“真实 Claude Desktop 已实测”。

## 不要提交什么

源码、资源、fixture 测试和脱敏文档可以进入 Git。以下内容不能进入公开仓库或普通发行目录，即使加密或看起来已打码，也应留在本地：

- `data`、`.qa`、`artifacts` 中的运行状态、验收产物、个人日志和未经审核的截图。
- `api-secrets.local.json`、`gateway.local.json`、`workbench.json`、费用账本、加密原配置备份和 Electron 的用户会话数据。
- `.codex`、`.claude`、Claude Desktop 用户配置、会员登录文件、导出的 VS Code 本机令牌片段。
- `.env`、私钥、证书、签名凭据、真实供应商 Key 和任何真实认证头。
- `node_modules`、`dist`、`release` 等可重新生成的目录，以及 Codex、Claude 等第三方官方安装程序。

二进制程序通过 GitHub Releases 分发，不直接提交进源码历史。第三方客户端的许可、下载方式和版本更新由对应厂商负责；未经许可核对和授权，不提供再打包、镜像或所谓免登录安装包。不要宣称国内所有网络环境均能访问 GitHub 或海外服务。

提交前查看 `git diff --cached` 和待提交文件列表；仅依靠 `.gitignore` 不会移除已经跟踪的私密文件。若曾提交密钥，应立即在供应商处轮换并清理泄露历史，不能只删最新版本的文件。

## 反馈和提交修改

Issue 建议附续航台版本、Windows 和官方工具版本、使用入口、复现步骤、期望行为与脱敏错误。不要粘贴真实 API Key、完整配置、认证头或项目私密内容。

PR 描述先说明用户问题和修改后的行为，再列相关验证及限制。新增供应商需明确地区、计费类型、协议、模型要求和官方依据；新模型或报价不能根据名称猜测。遵循仓库实际采用的 `LICENSE`，并保留第三方资源的许可证和归属说明。
