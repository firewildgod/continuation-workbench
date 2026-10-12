# 安装官方工具与分发范围

核对日期：2026-10-12。续航台管理连接和配置，用户仍需安装对应的官方工作台，并自行准备可用的账户或 API 凭据。续航台免费开源；模型服务按各供应商的计费和可用地区规则提供。

## 官方安装入口

| 工具 | 推荐入口 | Windows x64 备用官方入口 |
| --- | --- | --- |
| Codex / ChatGPT 桌面工作台 | [官方 Windows 安装说明](https://learn.chatgpt.com/docs/windows/windows-app) | [官方 Store 安装器](https://get.microsoft.com/installer/download/9PLM9XGG6VKS?cid=website_cta_psi) |
| Codex CLI | [OpenAI 官方 Releases](https://github.com/openai/codex/releases/latest) | [本项目 v0.2.3 离线附件](https://github.com/firewildgod/continuation-workbench/releases/download/v0.2.3/codex-cli-0.162.1-windows-x64-offline.zip)，CLI 0.162.1，核对校验值 |
| Claude 桌面 | [官方下载安装页](https://claude.com/download) | [官方 x64 安装器](https://claude.ai/api/desktop/win32/x64/setup/latest/redirect) |
| Claude Code 终端 | [官方安装说明](https://code.claude.com/docs/en/setup) | `winget install Anthropic.ClaudeCode` |
| Claude Code 图形面板 | [官方 VS Code 扩展说明](https://code.claude.com/docs/en/vs-code) | 在 VS Code 扩展市场选择 Anthropic 发布的 Claude Code |

官方下载链接可能重定向到最新版本，安装前检查发布者与签名。ARM64 用户应从官方页面选择对应架构，不使用 x64 附件冒充原生 ARM64 包。

本项目的 Codex CLI 附件保持官方原始 ZIP 不变，外层附带 Apache LICENSE、NOTICE、来源记录和中文说明。版本锁定 `rust-v0.162.1`，来源与原始哈希在附件 `ORIGIN.json`；外层 SHA-256 为 `e3e6bf1cb973802d7d6d7373aeac4b68fdc4ccfd1605ba8a313d2e642524c523`。附件是命令行工具，与独立桌面工作台不同，不自动安装，不附账号或额度。

组织内部 MSIX 部署请参阅 [OpenAI Windows 部署说明](https://learn.chatgpt.com/docs/enterprise/windows-deployment)；这类内部部署说明不等于允许将闭源桌面安装包作为公开 GitHub 镜像上传。

## 为什么没有将所有厂商安装包放进仓库

- Codex CLI 是 [Apache-2.0 开源软件](https://github.com/openai/codex/blob/main/LICENSE)，可按许可证条件再分发原版源码或二进制。单独离线附件包含许可证与来源，不能用该许可授权整个 Codex / ChatGPT 桌面应用。
- Claude Code 官方仓库的 [LICENSE](https://github.com/anthropics/claude-code/blob/main/LICENSE.md) 不是开源许可。官方 [法律与合规说明](https://code.claude.com/docs/en/legal-and-compliance)允许符合条件的客户在自己的产品中预装或运行未修改二进制，但要求保留官方认证、每用户使用自己的凭据、不转售或代付用量等。这不是独立公共安装包镜像的普遍授权。
- 本项目没有取得官方 Codex / ChatGPT 桌面或 Claude Desktop 的公开镜像授权，当前只提供官方安装入口。

## 下载方便不等于服务在所有地区可用

离线安装包可以减少安装时的重复下载，不能提供离线模型推理，也不能改变模型供应商的账户、地区或网络条件。

请核对 [Anthropic 支持地区](https://www.anthropic.com/supported-countries) 与 [OpenAI API 支持地区](https://developers.openai.com/api/docs/supported-countries)。中国大陆不在当前官方支持地区名单中，镜像安装器不能使官方服务自动变为受支持。GitHub 下载速度也取决于用户所在网络，本项目不承诺所有用户无需 VPN 即可使用所有官方服务。

为现有 API 选择兼容工作台时，请按供应商文档和许可核对协议与模型能力。当前核实的 Claude Desktop 版本拒绝 Qwen 等非 Claude 模型；终端与 VS Code 扩展的协议兼容性应单独验证，不用伪造模型名称。
