# AI 产品概念预览

这三张图片由内置 `image_gen` 生成，用于续航台的 GitHub README、发布说明和下载页。生成日期：2026-10-12。它们是 **AI 概念预览，不是运行截图，也不是厂商实测报告**。界面、装饰图标和布局可能与发布版本存在差异；实际功能以软件和接入文档为准。

| 文件 | 主题 | 实际尺寸 |
| --- | --- | --- |
| [product-overview.png](product-overview.png) | Codex、Claude Desktop、Claude Code 三个独立连接入口 | 1586 × 992 px |
| [usage-and-cost.png](usage-and-cost.png) | 今日费用、本月累计、单价来源和官方价格更新 | 1586 × 992 px |
| [portable-desktop.png](portable-desktop.png) | 安装版、便携 EXE 与 ZIP 的 Windows 发布形式 | 1586 × 992 px |

## 使用时须保留的说明

- 费用图中的 ¥1.28、¥18.64、单价及柱状图都是示例，不是用户账单、价格承诺或厂商最新报价。本机记录只用于费用估算，最终以厂商账单为准。
- 概览图中的“已配置”等状态是概念示意，不代表任何真实设备已完成接入验证。
- Claude Desktop 独立桌面入口与 Claude Code 终端 / VS Code 扩展分开配置。已检查的 Claude Desktop 2.31226.1 版本会拒绝 Qwen 等非 Claude 模型；图中百炼 Qwen 只出现在 Claude Code 卡片。
- 本产品是连接管理器；第三方工具需要另行安装。图片不表示已获得第三方安装包的再分发许可，也不表示捆绑安装包、免费无限 API 或无需登录。
- “便携”指续航台程序可直接运行。API Key 的本机加密数据与当前 Windows 用户 / 设备绑定，换电脑应重新填写密钥。
- 产品名用于说明连接对象。图标是普通软件 / 文件图标，避免使用第三方品牌标志；不代表 OpenAI、Anthropic 或其他厂商认可本项目。
- 下载页或 README 使用这些图片时，应保留图片上的“AI 概念预览”字样，或在紧邻图片的位置重复说明。

生成方式与完整提示词保存在 [prompts.json](prompts.json)。概览图在首次生成后使用同一内置工具做了一次局部修改，仅将中心卡片的品牌形状替换为普通显示器图标。
