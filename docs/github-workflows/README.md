# 可选 GitHub Actions 模板

这里的两个 YAML 文件是待启用模板，放在 `docs` 中不会触发 GitHub Actions。当前用于上传源码的凭据只有 `repo` scope，没有修改工作流所需的 `workflow` scope，因此发行时未写入 `.github/workflows`。

**v0.2.3 的记录来自本机验收，不是 GitHub 云 CI 通过的证明。** 两个模板截至 2026-10-12 尚未在本仓库的 GitHub runner 上运行。启用后应查看实际 Actions 日志，再描述云构建结果。

## 启用方法

有仓库维护权限的人可以通过 GitHub 网页编辑，或使用有工作流写入权限的 Git 凭据，把模板复制到对应目录：

```powershell
New-Item -ItemType Directory -Force .github/workflows | Out-Null
Copy-Item docs/github-workflows/windows-ci.yml .github/workflows/windows-ci.yml
Copy-Item docs/github-workflows/windows-release.yml .github/workflows/windows-release.yml
```

检查两个文件并提交到仓库后才会启用。通过 classic PAT 推送工作流需相应的 `workflow` scope；使用细粒度凭据时需所选仓库的 Contents 和 Workflows 写权限，并遵守组织策略。不要把任何访问令牌写进文件或提交到仓库。参见 [GitHub 的个人访问令牌说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)。

仓库 Settings → Actions 应允许所用的 GitHub 官方 actions。发布 job 请求 `contents: write`，仓库或组织策略需允许这一权限；CI 只请求 `contents: read`。运行时使用 GitHub 自动提供的 `GITHUB_TOKEN`，不需要把个人 PAT 或模型 API Key 配成发布 secret。参见 [GITHUB_TOKEN 权限说明](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token)。

## 模板执行什么

| 模板 | 触发与执行 |
| --- | --- |
| windows-ci.yml | main 分支 push、pull request 或手动执行；Windows、Node.js 22、公开源码检查、依赖安装、类型检查、构建、自动化测试和离线发行 guard |
| windows-release.yml | 仅 `v*` 标签 push；校验标签与 package 版本一致，执行同样检查，构建便携 EXE / ZIP / 安装 EXE，准备明确允许的公开目录，再创建 GitHub Release |

发布只上传续航台自己的三个程序和 `SHA256SUMS.txt`。它先创建草稿，上传成功后才公开；不包含 Codex、Claude、VS Code 等厂商安装包，不运行真实模型请求、官方客户端启动或用户配置验收脚本。如果同名 Release 已存在，模板会报错，避免自动覆盖现有文件；维护者应先核对原因和现有校验值。

发布前同步 `package.json`、锁文件、版本更新说明及下载页。标签必须为 `v<package版本>`，例如下一次发行使用相应的新版本；不要重新移动已公开的 v0.2.3 标签来补跑 CI。云 runner 需要访问 npm、Electron 下载源和 GitHub，模板不提供网络代理，也不改变供应商的地区或登录要求。

## 官方 action 固定版本

2026-10-12 通过官方 GitHub API 核对，模板固定为完整 commit SHA，后续更新时需重新核对并审查：

- [actions/checkout v7.0.1](https://api.github.com/repos/actions/checkout/git/ref/tags/v7.0.1)：`3d3c42e5aac5ba805825da76410c181273ba90b1`。
- [actions/setup-node v7.1.0](https://api.github.com/repos/actions/setup-node/git/ref/tags/v7.1.0)：`949feb2413d6458794dcd2491c4babbbce0c15c1`。

构建依赖的已知审计结果见 [依赖安全记录](../DEPENDENCY-SECURITY.md)。通过类型、测试或构建不表示已完成真实官方客户端和付费供应商端到端验证。
