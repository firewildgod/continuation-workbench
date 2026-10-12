# 续航台安装与首次使用

适用于续航台 0.2.3，Windows x64。续航台负责 API 连接、工具配置、网关转发与费用估算；编辑项目、读取文件和执行任务仍由你选择的 Codex 或 Claude Code 完成。

**下载入口：[GitHub Releases 最新版](https://github.com/firewildgod/continuation-workbench/releases/latest)。** 在 Release 的 Assets 中选择程序包。不要把含有个人 `data` 的在用文件夹发给别人；官方工作台另行安装，参见 [官方工具安装与分发说明](OFFICIAL-TOOLS.zh-CN.md)。

## 1. 下载哪个文件

进入项目仓库的 **Releases**，打开对应版本，在 **Assets** 中选一个程序包即可。GitHub 的 **Code → Download ZIP** 下载的是源代码，需要开发环境，普通用户应下载 Releases 的程序包。

| 文件 | 怎么使用 | 适合谁 |
| --- | --- | --- |
| `Continuation-Workbench-0.2.3-setup.exe` | 双击安装，选择自己的用户目录，按向导创建桌面快捷方式 | 第一次使用 |
| `Continuation-Workbench-0.2.3-portable.exe` | 放进固定且可写的文件夹，双击运行 | 想免安装使用 |
| `Continuation-Workbench-0.2.3-x64.zip` | 完整解压到固定且可写的文件夹，再运行 `续航台.exe` | 想保留完整程序目录 |

三种程序包都包含运行续航台所需的 Electron 环境，**无需另外安装 Node.js、npm 或 Python**。不要在 ZIP 压缩包里直接运行，也不要把便携版放进只读目录。当前仅提供 Windows x64 包，未提供 macOS、Linux 或 Windows ARM64 的发行包。

版本号随发行更新，以实际 Release 的文件名为准。Release 随附的 `SHA256SUMS.txt` 可用于核对文件完整性；例如在下载目录运行 PowerShell：

```powershell
Get-FileHash -LiteralPath '.\Continuation-Workbench-0.2.3-portable.exe' -Algorithm SHA256
```

对比输出与同一版本的校验文件。0.2.3 程序包尚无 Windows 代码签名，Windows 可能提示未知发布者；请先核对下载来源与校验值，不需要关闭系统安全软件。

## 2. 安装你要用的官方工作台

续航台程序包不包含 Codex、Claude Code、Claude Desktop 或 VS Code 的安装文件。先按对应厂商的官方指引安装所需工具，再打开续航台检测路径。软件里的官方工具名称和“路径设置”可以帮助你定位已经安装的程序。

| 你希望在哪里工作 | 需要安装什么 | 在续航台选哪个卡片 |
| --- | --- | --- |
| Codex 官方桌面工作台 | 官方 Codex 桌面应用 | **Codex** |
| Claude Code 终端 | 官方 Claude Code CLI | **Claude Code**，标有“终端 · CLI 配置” |
| Claude Code 图形界面，使用百炼等兼容 API | VS Code，以及官方 Claude Code 扩展；按官方指引准备所需运行环境 | 先配置 **Claude Code 终端**，再导出 VS Code 图形配置 |
| 独立的 Claude 桌面应用 | 官方 Claude Desktop | **Claude Desktop** |

官方安装与扩展说明：

- [Claude Code 安装说明](https://code.claude.com/docs/en/setup)
- [Claude Code 官方 VS Code 扩展](https://code.claude.com/docs/en/vs-code)
- [Claude Desktop 第三方推理配置](https://claude.com/docs/third-party/claude-desktop/in-app-configuration)
- [Codex 官方产品入口](https://openai.com/codex/)

**Claude Desktop 与 Claude Code 的 VS Code 扩展是两个不同入口。** 0.2.3 的桌面自动配置已核实 Claude `2.31226.1.0`；该版本拒绝 Qwen、DeepSeek 等非 Claude 模型。你购买百炼 Qwen API 时，选择终端或 VS Code 扩展，不要在独立 Claude Desktop 卡片强行应用。真实 Claude 模型 API 才适用于当前已适配的桌面入口；其它桌面版本请查看应用中的兼容提示和官方配置窗口。

## 3. 添加自己的 API

1. 打开续航台，进入 **API 连接**，点击 **新增连接**。
2. 选择供应商及计费方式，然后选择 Codex 或 Claude Code。优先使用相应供应商预设，软件会按工具填写协议和默认地址。
3. 填连接名称、自己的模型 **API Key** 和账号已开通的模型 ID。模型候选可以选择，也可以手动填写准确 ID。
4. 点击 **保存并测试**。这会向供应商发送一次短请求，通常产生小额正常 API 用量；结果记入本机费用记录。

API 是供应商单独计费的服务，续航台不附赠会员或模型额度。ChatGPT/Claude 会员、阿里云 AccessKey ID、百炼普通模型 API Key 与 Token Plan 专属 Key 不能混用。模型是否可调用，以你的供应商账号、地域、权限和余额为准。

以北京地域的百炼普通按量 API 为例：

| 使用工具 | 接口协议 | 服务地址 |
| --- | --- | --- |
| Codex | Responses | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Claude Code 终端或 VS Code 扩展 | Anthropic Messages | `https://dashscope.aliyuncs.com/apps/anthropic` |

两个地址不能互换，Key 与地域也需匹配。包月、其它地域或业务空间使用各自对应的预设与官方地址。自定义供应商需要支持所选工具要求的协议；“兼容 OpenAI”不自动表示支持 Codex 所需的 Responses，更不表示所有工具、图片或模型功能均可用。

## 4. 应用到工作台

### Codex

1. 回到 **工作台 → Codex**，使用方式选 **外部 API**，选刚保存的 Codex 连接。
2. 点击 **预览并应用**，检查模型、地址和修改内容。
3. 保存当前 Codex 工作，并从原应用完全退出。返回续航台，点击 **应用这份配置并保存备份**。
4. 重新打开 Codex，新建聊天，并用一个简单任务确认连接。旧聊天可能保留之前的供应商，不能只看旧聊天推断新配置。

### Claude Code 终端

1. 在 **Claude Code** 终端卡片选 **外部 API**，再选自己的 Anthropic Messages 兼容连接。
2. 点击 **预览并应用**，核对后应用。原设置会加密备份，原有权限、hooks 和其它设置保留。
3. 关闭原来的 Claude Code 会话，重新 **打开终端**，在原工具中使用 `/status` 核对本机网关和模型。
4. 选择一个可丢弃的测试文件夹，让它创建 `hello.txt` 并读回内容；文件访问和命令权限仍需按原工具的提示确认。

### Claude Code 的 VS Code 图形扩展

1. 先完成上面的 Claude Code 终端 API 配置；确认卡片显示当前使用的是这条 API 连接。
2. 点击 **导出 VS Code 图形配置**。打开生成的片段，不要把它上传到 GitHub。
3. 在 VS Code 执行 **Preferences: Open User Settings (JSON)**，把片段中的 `claudeCode.environmentVariables` 合并到当前 Profile 的用户设置。保留其它设置，不要写到会提交 Git 的项目配置。
4. 保存设置，完全退出并重新打开 VS Code，进入官方 Claude Code 面板、选择项目文件夹并新建会话。用一次简单的文件任务验证。

导出片段包含当前电脑的本机网关令牌；该令牌不是供应商 API Key，但仍应保存在自己的用户设置中。

### 独立 Claude Desktop

选择 **Claude Desktop** 卡片及兼容的真实 Claude 模型连接。预览后先保存任务并完全退出 Claude 桌面，再应用配置并重启。桌面配置与终端配置独立，会影响桌面的 Chat、Cowork、Code；只有经过该桌面网关的实际成功请求后，卡片才会显示“已验证”。

未知版本、受管理策略控制或格式不兼容时，自动应用会停止，请按提示使用官方配置窗口。完整细节见 [Claude 桌面接入指引](claude-desktop-guide.md)。

## 5. 日常怎么打开

**先打开续航台，再打开要用的官方工具。使用外部 API 时，让续航台保持运行。** 关闭续航台主窗口会收进系统托盘，本机网关继续工作；从托盘退出会停止网关，正在使用该网关的工具会无法继续请求模型。

进入 **用量与费用** 查看今日、本月估算和请求明细。“更新官方价格”联网核对受支持的公开报价，不发送模型请求。没有价格或用量时显示未计价，不能当作免费。费用只覆盖经过本机网关及本软件连接测试的请求，实际扣款、赠额、折扣和套餐扣减以供应商账单为准。

本机网关不会提供 VPN 或改变供应商访问权限。安装程序可运行不等于海外账号登录、购买或 API 在当前网络一定可访问；国产 API 也需要正常连接所选供应商的服务器。

## 6. 升级、换机和恢复

### 同一台电脑升级

等 API 请求结束，保存原工具的工作，从旧续航台托盘退出，再更新程序。保留原来的 `data`，不要同时运行两个续航台实例占用同一端口。

- 便携 EXE：把新版 EXE 放进原来的文件夹，运行新版。
- ZIP：退出旧程序后更新程序文件，保留 `data`；不要将另一个用户的 `data` 覆盖进去。
- 安装版：退出旧程序后运行新版安装向导，使用原用户和原目录；升级前可以另存一份自己保管的 `data` 备份。

0.2.3 的价格更新按钮只更新价格，不会自动升级续航台本身；软件新版本从 [GitHub Releases](https://github.com/firewildgod/continuation-workbench/releases/latest) 下载。

### 换电脑或 Windows 用户

三个版本的数据都保存在程序目录旁的 `data`。API Key、本机令牌与原配置备份使用 Windows 系统加密，复制文件夹不能让另一台电脑或另一用户直接解密。

在 **备份与设置 → 导出无密钥备份** 可以生成连接参数清单；它不含供应商 Key、会员凭据、本机令牌或加密原配置。新电脑先安装所需官方工具，根据清单重新添加连接、重新输入 Key 并应用配置；在官方工具中重新登录。0.2.3 没有自动导入连接清单的界面，请按清单填写。

不要把原电脑的加密配置备份当作新电脑的官方配置恢复源。原备份与原机、原用户和原配置路径相关。

### 切回官方账号或原配置

在对应工具卡片选择 **官方账号 / 原配置**，预览并应用，然后重新启动原工具。也可使用对应备份的 **恢复** 或 **回滚**。恢复的是首次接管前的配置；如果当时已经使用第三方 API，恢复不会自动获得官方会员额度。

若准备停用或卸载续航台，先恢复所有已接管入口并在原工具验证，然后退出续航台，避免工具继续指向已停止的本机网关。

## 7. 常见问题

| 问题 | 处理方式 |
| --- | --- |
| Claude Code 返回 404 | 检查是否错用了 Codex 的 `/compatible-mode/v1` 地址；百炼 Claude Code 应选 Anthropic Messages 的对应地址 |
| 返回 401/403 或提示余额不足 | 在供应商控制台检查 Key、地域、模型权限和余额；不要向 Issue 粘贴 Key |
| 本机网关连接失败 | 确认续航台仍在托盘运行、网关显示运行中，且没有第二份程序占端口 |
| “未定位程序”或打开按钮不可用 | 先安装所需官方工具；在路径设置中选择真实程序，再刷新状态 |
| 已应用，但原工具仍显示原模型 | 保存工作、完全退出后重开工具，并新建会话；VS Code 还需合并用户设置 |
| Claude Desktop 连接显示“当前桌面不支持” | 该客户端版本拒绝所选模型；Qwen 等连接改走 Claude Code 终端或 VS Code 扩展 |
| 配置被外部修改，不能恢复 | 核对原工具或其它配置管理器的修改，重新预览；不要为消除提示强行覆盖 |
| 费用显示未计价 | 请求未返回完整 Token 用量或没有可用报价；看供应商账单，必要时手动设置单价 |

提交问题时提供续航台版本、Windows 与工具版本、入口名称及脱敏错误信息。不要上传 `data`、API Key、登录凭据、完整配置片段或真实账单截图。
