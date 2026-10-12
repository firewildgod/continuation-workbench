# 依赖安全扫描记录

核对日期：2026-10-12。项目版本：0.2.3。扫描对象是当时的 `package-lock.json` 和 npm 公告数据库；这份记录不能保证未来数据库或上游版本保持相同结果。

## 确切结果

| 检查 | 结果 |
| --- | --- |
| `npm audit --json` | 8 个 moderate，0 个 high，0 个 critical |
| `npm audit --omit=dev --json` | npm 生产依赖范围内报告 0 条已知公告 |
| `npm audit fix --dry-run --ignore-scripts --json` | 0 添加、0 更新、0 移除；8 个 moderate 仍存在 |

八个条目均来自 `electron-builder` 的开发和构建依赖链，锁文件中均标记为 `dev: true`。生产依赖图没有这些包。它们对应一个根源公告及其向上游传播的影响，不是八个独立根源漏洞。

| 包 | 锁定版本 | 范围 |
| --- | --- | --- |
| electron-builder | 26.15.3 | 直接开发依赖，打包工具 |
| app-builder-lib | 26.15.3 | 构建传递依赖 |
| dmg-builder | 26.15.3 | 构建传递依赖 |
| electron-builder-squirrel-windows | 26.15.3 | 构建传递依赖 |
| @electron/get | 3.1.0 | app-builder-lib 下的传递依赖 |
| global-agent | 3.0.0 | 构建下载代理的传递依赖 |
| roarr | 2.15.4 | 日志传递依赖 |
| sprintf-js | 1.1.3 | 公告涉及的根源包 |

主要链路：`electron-builder → app-builder-lib → @electron/get@3.1.0 → global-agent → roarr → sprintf-js`。项目 Electron 下载器另有 `@electron/get@5.1.0`；本次公告没有将该实例列为受影响节点，不能把所有同名包实例混为一谈。

[GitHub 公告 GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)记录 `sprintf-js <= 1.1.3` 的格式字符串精度参数可引发拒绝服务；公告当时没有列出修复版本。扫描没有验证本项目构建流程是否存在实际可利用的输入路径。

## 更新结论与贡献建议

npm 报告中的 `fixAvailable: true` 不等于本机已经得到修复。实际执行的 dry-run 没有改变依赖图，仍报告八个条目。查询到的 `sprintf-js` 已发布版本最高为 1.1.3；`app-builder-lib@26.15.7` 和 `@26.17.0` 仍声明 `@electron/get: ^3.0.0`，因此没有证实通过当前构建链的常规 patch/minor 升级即可修复。

贡献者应在独立分支重新运行以上扫描，核对上游修复公告和实际解析后的依赖图。若选择升级构建工具、回退版本或覆盖传递依赖，应单独审查兼容性，并完成类型检查、测试、Windows 三种程序构建及打包验收后再提交。不要为清除计数直接执行 `npm audit fix --force`，也不要将扫描忽略或关闭当作漏洞修复。

`npm audit --omit=dev` 的零条目只说明该次 npm 公告扫描的生产库结果，不代表软件整体没有安全问题。Electron 和 Chromium 二进制、配置管理、网关及第三方官方工具仍需要各自的版本更新与安全检查。

本次检查没有修改 `package.json`、锁文件或用户 API 配置，没有读取密钥库，也没有发起模型调用。
