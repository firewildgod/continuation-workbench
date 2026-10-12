# 续航台 0.2.3

本版整理公开源码与 Windows 发行包，供其他用户下载、安装和自行接入 API。

下载：[GitHub Releases 最新版](https://github.com/firewildgod/continuation-workbench/releases/latest)。普通用户在 Assets 选择 `portable.exe`、`x64.zip` 或 `setup.exe`，无需安装 Node.js 或 Python；GitHub 的源码 ZIP 需要开发环境。完整步骤见 [安装指南](INSTALL.zh-CN.md)。

- 项目采用 MIT 许可，补充第三方许可证与版权说明。
- 提供普通用户安装指南、贡献指南、官方工作台安装入口和分发范围说明。
- 开发脚本使用项目 Playwright 依赖或环境参数，移除开发机器专属路径。
- 公开源码按允许清单导出，排除密钥、会员凭据、便携数据、费用账本、真实 API 验收目录及个人报告。
- 发布目录检查精确文件清单和 SHA-256，发现未知遗留文件或符号链接时停止；不会删除未知文件。
- Windows 便携 EXE、安装版 EXE 与 ZIP 均内置 Electron，普通用户无需安装 Node.js 或 Python。
- README 与下载页增加三张 AI 产品概念预览，分别介绍独立连接入口、费用与单价来源、Windows 发行形式；保留概念标识，并将示例费用与本机 fixture 验收截图分开说明。

API 路由、费用统计与配置备份行为延续 0.2.2。用户自备 API Key，费用按各供应商实际用量结算；开源程序不提供免费模型额度或不限量推理。

开发机器已验证百炼 Qwen 的 Claude Code 终端创建/读回文件，以及 VS Code 官方图形面板回复。安装包验收使用独立测试目录，不携带这些个人记录。其他供应商与客户端版本仍应自行验证。

Claude Desktop、Claude Code 终端和 VS Code 扩展分别配置。当前核实桌面版拒绝 Qwen 等非 Claude 模型；支持 Messages 协议不代表所有桌面模型都兼容。

官方工具通过厂商渠道安装，当前不公开镜像第三方桌面安装包。本次提供 Codex CLI 0.162.1 的独立 Apache-2.0 离线附件，附 LICENSE、NOTICE、版本、来源和校验值，不随续航台捆绑安装；该许可不覆盖 Codex / ChatGPT 桌面应用。官方入口和具体分发范围见 [官方工具说明](OFFICIAL-TOOLS.zh-CN.md)。

本版安装包未购买 Windows 代码签名证书。实际网络与服务可用性依用户地区、账户及供应商政策而定。
