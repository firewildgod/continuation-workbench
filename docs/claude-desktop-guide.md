# Claude Code 接入：先确认使用的是哪个入口

续航台 0.2.2 提供独立的 **Claude Desktop（桌面工作台）** 与 **Claude Code CLI（终端版）** 卡片。桌面路由使用独立的第三方推理配置，不通过 `~/.claude/settings.json` 切换。桌面快捷方式能打开 Claude，不等于它已经使用续航台里的 API 连接。

本机核实的 Claude 桌面 `2.31226.1.0` 会拒绝 Qwen、DeepSeek 等非 Claude 模型；百炼的 Messages 接口和桌面入口文档不能保证该具体版本的模型选择器接受它们。续航台在桌面选择此类连接时会显示原因并阻止写入，保留终端与 VS Code 路径。详细证据见 [桌面版本兼容性](claude-desktop-compatibility.md)。

## 百炼普通按量 API → Claude Code CLI

1. 在「API 连接」选「阿里百炼 · 按量」，使用工具选「Claude Code CLI」。
2. 北京地域普通 API 的服务地址填 `https://dashscope.aliyuncs.com/apps/anthropic`，协议选 **Anthropic Messages**。模型可选 `qwen3.8-flash`、`qwen3.8-max`、`deepseek-v4.1-flash`、`deepseek-v4-pro`、`glm-5.3`、`kimi-k3`，以当前账号权限为准。
3. 填百炼普通模型 API Key。阿里云 AccessKey ID 与 Token Plan 专属 Key 不能替代它。其他地域或业务空间专属域名请按控制台填写，Key 与地域必须配套。
4. 保存并测试。测试会发送一次短请求，产生的 usage 会记入续航台费用统计；鉴权通过仍需验证真实工具使用。
5. 在「工作台」的 Claude Code CLI 卡片选择 API 连接，预览并应用配置。续航台会加密备份旧设置、保留其他配置，并把本机网关地址和本机令牌写入 CLI 设置。
6. 保持续航台运行，重新打开 Claude Code CLI。输入 `/status`，检查 API 地址是否指向续航台本机网关，并查看选用模型。
7. 在一个可丢弃的测试文件夹中提出「列出这个文件夹里的文件，创建 hello.txt，内容是 hello，再读回来确认」。在 Claude 自身的权限提示中确认后验证文件存在；续航台的请求记录应出现该连接与模型。

截图中的 `https://dashscope.aliyuncs.com/compatible-mode/v1` 是 Codex/OpenAI 兼容端点。搭配 Anthropic Messages 协议会访问不存在的路径并返回 404；错误不代表 API Key 或余额一定有问题。新版会在发送请求前提示修正。

主对话、Haiku、Sonnet、Opus、Fable、旧版 small-fast 槽位及子 Agent 都映射到选定连接的模型，避免后台任务继续请求原来的 Claude 模型。供应商 Key 留在续航台加密库；CLI 配置只保存本机网关令牌。切回原配置时从加密备份恢复。

## Claude Code 的 VS Code 扩展

1. 在续航台导出 Claude 的 VS Code 设置片段。
2. 在 VS Code 执行 **Preferences: Open User Settings (JSON)**。
3. 将导出的 `claudeCode.environmentVariables` 项合并到用户设置中；不要覆盖其他设置，也不要写入会提交到 Git 的项目配置。
4. 完全退出并重新启动 VS Code。保持续航台运行，进入扩展用 `/status` 检查，再进行一个小型文件任务。

CLI 设置中的变量会进入扩展的子进程，但不一定参与扩展自身的登录检查，因此必须单独设置扩展环境变量。导出的片段含本机网关令牌，应只在当前电脑使用。

## Claude 桌面应用的 Code 标签

真实 Claude 模型的 API：在工作台 **Claude Desktop** 卡片选择外部 API 与连接，预览，先保存任务并完全退出 Claude 桌面，再应用配置并重启。新版独立保存桌面路由，对三处配置文件加密备份；恢复原配置不会改变终端路由。进入新会话后，真实请求成功才会显示已验证并记入费用。桌面配置同时影响 Chat、Cowork、Code。

其它尚未核实的桌面版本不会自动写入。可以按官方窗口配置；不要通过修改 CLI 的 `settings.json` 判断桌面版已经切换：

1. 保存当前任务。在 Claude 桌面应用菜单中进入 **Help → Troubleshooting → Enable Developer Mode**。应用可能重启。
2. 进入 **Developer → Configure Third-Party Inference…**。
3. 在 **Connection** 中选择 **Gateway**，按官方配置窗口要求填写网关地址、认证方式、模型列表。组织策略管理的配置可能是只读状态。
4. 使用配置窗口的测试功能，检查连接和模型列表；点击 **Apply Changes** 才会应用到本机并重新启动。仅导出配置不会改变当前推理路由。
5. 新开 Code 会话，验证简单对话、文件读取、创建文件与子 Agent。完整测试通过前不要声称桌面版已接入。

如果手动将桌面版直接指向供应商端点，请使用供应商对应的 Anthropic 地址与 Key。这样请求绕过续航台，本机费用统计不能记录它。若后续通过续航台接入桌面版，则桌面配置必须使用续航台的**本机令牌**，供应商 Key 只留在 API 连接中；还需要验证桌面模型角色映射与模型目录行为，不能混填凭据。

桌面版把本地配置放在 `%LOCALAPPDATA%\Claude-3p\configLibrary\`，企业策略可覆盖它。0.2.2 的自动配置根据本机已安装版本的实际配置读取代码核实，只维护自己的模型配置条目、当前条目索引与部署模式；其它条目保留。原文件完整加密备份，外部修改后停止覆盖。不向注册表写企业策略；遇到管理策略、未知客户端版本或不兼容格式，使用官方配置窗口。

## 核对依据

- [百炼 Claude Code 接入说明](https://help.aliyun.com/zh/model-studio/claude-code)
- [百炼 Anthropic Messages 模型和地域支持](https://help.aliyun.com/zh/model-studio/anthropic-api-messages)
- [Claude Code：网关、CLI、VS Code 与桌面配置区别](https://code.claude.com/docs/en/llm-gateway-connect)
- [Claude 桌面第三方推理配置窗口](https://claude.com/docs/third-party/claude-desktop/in-app-configuration)
- [Claude 桌面配置来源和 Windows 优先级](https://claude.com/docs/third-party/claude-desktop/mdm)

核对日期：2026-10-12。本文不包含 API Key、会员凭据或项目内容。
