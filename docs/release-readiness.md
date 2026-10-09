# 发布与验证

目标仓库：Zssan12/obsidian-study-companion。版本 0.1.0，原创代码 MIT，作者 Zssan12。用户已授权公开源码和 GitHub 分发；早期仅允许本地内测的限制已被本次发布请求替代。

## 安装包

`npm run package` 先构建，再在 artifacts 下创建唯一目录，生成 `study-companion-0.1.0.zip` 与同名 `.sha256`。ZIP 以明确的文件白名单打包：运行文件、许可证和隐私说明、Mac/Windows 教程、排查/反馈与构建信息。没有个人设置、history.json、账号目录、测试仓库或 node_modules。

唯一构建编号保留在 BUILD-INFO.json，用户下载文件名不带 dev/beta。普通语义版本和文件名不代表所有功能已在每个平台验收。

## 发布步骤

1. 使用 Node.js 22，运行 npm ci、npm run check、npm audit --audit-level=moderate。
2. 运行 npm run release:check、npm run package，检查归档内容和 SHA-256。
3. 提交公开源码并推送；确认 GitHub Validate 工作流通过。
4. 手动执行 Draft release 工作流。它将同一构建的 ZIP、校验文件和 main.js / manifest.json / styles.css 上传为草稿。
5. 核对内容后发布草稿；tag 必须与 manifest.version 一致，例如 0.1.0，无 v 前缀。不要覆盖已经发布的版本，更新时升级版本号。

GitHub 发布不等于在 Obsidian 社区目录上架。本次范围不包括社区审核提交。

## 验证边界

- 历史自动化结果：951 测试 / 92 文件通过，以及类型、lint、模块边界、构建检查。当前发布仍须重新执行，不将历史结果当作本次结果。
- macOS 有此前独立测试库的部分真实交互记录；本次安装包尚未完整重走所有真实模型功能。
- Windows 路径发现有自动化回归，Windows 实机全流程验收仍待完成。此前目录显示异常尚不能声称已找到并修复 Windows 根因。
- Claude/Codex 账号、模型可用性与外部服务变化无法用模拟测试证明。
- 卸载/升级、浅色/深色、窄侧栏、多窗口、实际 Windows 首次安装应在独立测试库继续验收，未知不能标为通过。
- manifest 的 minAppVersion 是声明支持下限，并非所有对应系统组合的认证。

不因发布而清理用户目录、不触碰日常库或登录文件。第三方 SDK 与词典保留各自条款，见 THIRD_PARTY_NOTICES.md。

## 2026-10-09 发布构建检查

- 本次 npm run check：92 文件、953 测试通过；类型、lint、模块边界、构建通过。
- npm run release:check 通过；独立 ZIP 检查确认 12 个白名单条目、CRC、三件套字节及 SHA-256 一致。
- 修复本次审计报告的间接依赖；Obsidian API 仍为 1.13.1，开发依赖 moment 单独覆盖为 2.31.0。npm 审计报告零已知漏洞。
- 安装说明按官方文档核对，Mac/Windows 入口及本地文档链接检查通过；不代表 Windows 实机验收。
- 干净安装复现并修复 npm 10 的可选 peer 锁文件缺项：补齐 Vite 使用的 esbuild 0.28.2，保留插件构建器 0.25.5；npm 10.9.4 干净安装后完整 953 测试与构建再次通过。
