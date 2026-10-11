# 更新日志

## 0.1.1

修复 PDF 按主题讲解后，划词追问导致学习目录消失、无法切换主题，以及重新梳理报错的问题。

**下载安装：** 在下方 Assets 中选择 `study-companion-0.1.1.zip`（Mac/Windows 通用），不要选 Source code。

- 追问时保留已保存目录和学习进度，普通问题仍使用本次选中文字。
- 选择其他主题或输入“继续”时，使用原目录的资料范围讲解。
- 重新梳理会准备完整的 PDF 资料；准备失败或取消时保留原目录。
- README 和 Mac/Windows 教程同步更新安装包名称，并提供可复制的 AI 安装提示词。

升级前备份插件目录，替换 main.js、manifest.json、styles.css，保留 data.json 和 history.json；随后重启 Obsidian 或停用再启用插件。

验证：959 项自动化测试、类型检查、Lint 和构建通过；macOS Obsidian 1.14.4 测试库实测 PDF 划词后目录仍能展开并选择主题。真实模型追问未重复发送，Windows 实机完整验收仍未完成。

## 0.1.0

首个 GitHub 分发版本，保留现有完整功能。

**下载安装：** 在下方 Assets 中选择 `study-companion-0.1.0.zip`（Mac/Windows 通用），不要选 Source code。

[Mac 安装教程](https://github.com/Zssan12/obsidian-study-companion/blob/main/docs/installation/MAC-SETUP.md) · [Windows 安装教程](https://github.com/Zssan12/obsidian-study-companion/blob/main/docs/installation/WINDOWS-SETUP.md) · [故障排查](https://github.com/Zssan12/obsidian-study-companion/blob/main/docs/installation/TROUBLESHOOTING.md)

- 普通聊天、按资料独立保存的学习对话，以及隔离的 Quick Ask 追问。
- Markdown 全文/选区目录、PDF 目录与主题讲解、重新梳理和学习进度恢复。
- 离线英汉词典、词形与漏字候选，多 PDF 批量“突击”讲解。
- 文件/图片附件、笔记检索、按需联网与来源链接。
- 收藏、预览后整理为 Markdown、插件内部聊天历史。
- 紧凑输入框、独立且持久保存的上下文用量。
- 清空当前对话、已删除记录恢复、再次确认后彻底删除。
- Mac / Windows 从零安装、故障排查、升级备份说明；通用 ZIP 和 SHA-256 校验文件。

桌面端 Obsidian 1.13.0+，需要自己的官方 Claude 或 Codex CLI 登录与服务权限。Windows 实机完整验收仍未完成；未上架 Obsidian 社区商店。详见 docs/release-readiness.md。
