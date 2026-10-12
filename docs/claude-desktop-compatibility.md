# Claude 桌面第三方 API 兼容核对

核对日期：2026-10-12。本记录仅描述本机已安装的 **Claude Desktop 2.31226.1**，不把当前行为推广到所有历史或未来版本。检查未读取登录凭据、其他供应商配置内容、浏览器缓存或会话内容；未发起付费推理，也未改动本机 Claude 配置。

## 官方支持与本机证据

Anthropic 官方的 [Claude Desktop on 3P 概览](https://claude.com/docs/third-party/claude-desktop/overview)明确支持桌面 Chat、Cowork、Code 通过配置的推理供应商或兼容网关运行。[配置参考](https://claude.com/docs/third-party/claude-desktop/configuration)确认 Windows 用户级保存位置为 `%LOCALAPPDATA%\Claude-3p\configLibrary\`：`_meta.json` 记录当前条目，旁边的 `<id>.json` 保存配置。配置在启动时读取，管理策略优先于本机配置。

[单机设置流程](https://claude.com/docs/third-party/claude-desktop/installation#single-machine-setup)和[应用内配置窗口](https://claude.com/docs/third-party/claude-desktop/in-app-configuration)提供官方的进入、导入、应用及重启路径。续航台的自动激活文件格式由本机安装源码核实，源码位置和指纹见下文。

本机安装元数据：

- MSIX：`Claude_2.31226.1.0_x64__pzs8sxrjxfjjc`。
- 程序：`C:\Program Files\WindowsApps\Claude_2.31226.1.0_x64__pzs8sxrjxfjjc\app\claude.exe`。
- 程序 `FileVersion`、`ProductVersion` 均为 `2.31226.1`，公司为 Anthropic；ASAR `package.json` 的版本也为 `2.31226.1`。
- 源码包：同目录的 `resources\app.asar`。只读检查时实际用户的 `Claude-3p\configLibrary` 尚不存在。

## 保存与激活格式

ASAR 的 `.vite/build/index.chunk-EzXl5k4A.js` 中，`JF`/`XF` 从默认 `{appliedId: "", entries: []}` 建立配置库；条目形状包含 `{id, name}`。`LWn` 切换 `appliedId`，并在选择其他配置时删除 `hybridPointer`。`AHe` 按 `appliedId` 读取对应 `<id>.json`。

`.vite/build/index.pre.js` 的 `KQ` 在 Windows 将第三方配置根定位到 `%LOCALAPPDATA%\Claude-3p`。`GQ` 是 `claude_desktop_config.json`；`n0`/`r0` 读取其 `deploymentMode`，已保存的 `1p` 选择会阻止通常的 3P 激活。主源码的 `eI` 通过更新该文件的 `deploymentMode` 写入 `3p`。

因此适配器只管理三处：专用 UUID 的配置、`_meta.json`、`claude_desktop_config.json` 中的部署模式。其他配置条目文件不读取、不修改。原三文件按原始字节加密备份；预览、备份后、原子替换前及恢复时检查哈希，不覆盖外部修改。不会写企业 Policy 注册表，不会修改会员凭据或 CLI 的 `.claude/settings.json`。

配置索引的未知形状、重复或无效 ID、非普通文件、符号链接、专用 UUID 外部占用、运行中的 Claude，以及覆盖本机配置的管理策略，均停止自动写入。适配器默认通过只读 MSIX 元数据检查，只允许已核实的 `2.31226.1.0`；主程序也可传入版本检查回调。未知或无法确认的版本将状态标记为 `manual-import` 引导模式，并拒绝预览、应用及恢复的自动写入。此时应通过官方配置窗口和诊断报告核对，不能凭已有文件声称接入完成。

## 模型限制：百炼文档与当前客户端的差异

百炼官方的 [Anthropic 兼容 Messages 文档](https://help.aliyun.com/zh/model-studio/anthropic-api-messages) FAQ 明确提到 Claude Desktop，建议手动添加 Qwen 模型以跳过缺失的 `/v1/models`。这证明供应商提供了兼容接口及客户端排错指导，但不能保证本机当前版本接受该模型名。

当前 **2.31226.1** 的安装源码存在以下实际检查。下面 offset 是已核对文件中的字符位置，用于重新定位，不是源码行号：

1. 主源码 `Co`（538063）按供应商分发。`gateway` 进入 `ISe`，调用 `So`。`DSe` 中的非 Claude 名称片段包括 `qwen`、`deepseek`、`glm`、`kimi`、`minimax` 等；匹配时拒绝模型。允许的网关路由应引用 Anthropic 模型。
2. 平铺配置验证 `iMe`（700511）检查 `inferenceProvider` 与 `inferenceModels`。部分模型通过时删去其他模型；**全部模型未通过时，它保留原始列表并产生模型问题记录**。不能仅据这个过滤函数判断会话能否使用。
3. 真正的渲染模型列表 `Vpn`（2828663）从配置的模型构建列表后，再按 `Co(provider, model).ok` 过滤。gateway 下的 Qwen 原名因此不会进入可用模型列表。
4. 会话模型验证 `validateSessionModel`（2827092）也调用 `Co`。Cowork 的 `I6i`（约 5731800）和 Code 的 `Wla`（约 6067687）使用它；无效选择会回落到默认模型解析。`pVe`（854269）的例外只针对计划任务保存时的 `desktop_update_required`，不豁免非 Claude 模型。

仅在隔离 VM 中执行提取的纯模型检查函数，没有加载整个应用或运行网络请求，结果为：`qwen3.8-max`、`deepseek-v4-pro` 返回 `ok:false`，`claude-sonnet-4-6` 返回 `ok:true`。这确认原名的客户端选择限制；不能据此宣称所有 3P 启动都被阻止，也不能把回落默认模型算作 Qwen 明确配置成功。

续航台保留独立桌面入口，允许真实 Claude 模型路由；对 Qwen、DeepSeek、GLM、Kimi、MiniMax 及未确认的非 Claude 路由，在写入前停止并说明可以使用 Claude Code 终端或 VS Code 图形扩展。不会把 Qwen 改名为 Claude 来绕过客户端规则。

## 网关字段与模型角色

本机源码以及官方配置参考都确认 `inferenceCredentialKind: "static"`、`inferenceGatewayApiKey`、`inferenceGatewayAuthScheme: "bearer"` 合法。源码 `Pke`（627451）允许 `bearer`/`x-api-key`；`Fke`（约 627944）是 gateway 的 static credential；`Yke`（约 633760）使用 `Ps` URL 验证器。`Ps = Ns({allowLoopbackHttp: true})`（约 566047）允许本机 loopback HTTP。适配器进一步只允许 `http://127.0.0.1:端口/claude-desktop`。

`inferenceModels` 使用供应商的真实 ID，关闭自动发现。`anthropicFamilyTier` 只按该真实模型名可识别的家族设置，Opus 设置 `opus`、Haiku 设置 `haiku`、Sonnet 设置 `sonnet`；未知家族不猜测。不会增加假模型、宣称不存在的上下文窗口或能力。

主源码 `etn`（2534179 附近）将已配置的家族条目转换为 `ANTHROPIC_DEFAULT_<TIER>_MODEL`；未设置的其他角色可能使用 CLI 默认模型名。无需为一个真实模型人为复制三种家族条目来让界面显示假角色。续航台的本机网关始终按选中连接的真实模型处理请求，桌面配置和调用记录必须同时核对。

## 验收与版本更新

`configured` 仅表示本机文件已经设置，并要求重启；`verified` 必须由独立桌面网关路由上成功的实际模型请求证明，模型列表查询不能算验证。当前请求选择的模型、连接或令牌变更后，旧的成功记录不能自动证明新配置。

官方验收路径为 Help → Troubleshooting → Generate Diagnostic Report。官方文档说明报告的 `managed-config.txt` 展示实际读取来源及脱敏键，`provider-status.txt` 展示配置有效性，`deployment-mode.txt` 展示是否运行于 3P。可先在隔离配置目录及本机 mock 网关中验证启动和读取，不必对真实付费供应商请求。

源码指纹：

- `.vite/build/index.chunk-EzXl5k4A.js`：6,888,482 字节，SHA-256 `ab1441a994db58d6637bc2dd26c75e178eb69751ed0102b07ca8d927644e211d`。
- `.vite/build/index.pre.js`：906,128 字节，SHA-256 `360fef2bda7f41ca539004ea26492a506af6a36ff79df069b7d143574800702e`。

更新 Claude 后应重新核对配置库 schema、模式选择、模型列表过滤及会话检查。未知源码规则不能通过伪造模型名解决；若官方将来明确开放其他模型，应以新版本证据和隔离验收更新适配器及本记录。
