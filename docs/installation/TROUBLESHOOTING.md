# 常见问题：按现象处理

先找对应的一行；不需要重装整个仓库。

| 现象 | 处理办法 |
| --- | --- |
| 解压后只有 src、tests、package.json | 下载了源码。在 Releases 的 Assets 里选 `study-companion-0.1.1.zip` |
| 插件列表没有 Study Companion | 检查三件套是否在当前仓库配置目录的 plugins/study-companion 下，避免多套一层；重启 Obsidian |
| 找不到 .obsidian | 先用 Obsidian 打开该仓库；Mac 在 Finder 按 Command+Shift+.；Windows 在地址栏直接输入仓库路径后加 \.obsidian |
| 不知道 CLI 是什么 | 它是连接模型的本机程序。按 Mac 或 Windows 教程安装 Codex/Claude 其中一个，再登录自己的账号 |
| CLI 路径为空 | 先在终端确认对应 CLI 能启动，重启 Obsidian，再点“重新检测 CLI 路径” |
| 路径还是旧的 | 检测只补空白项。先清空错误路径，再检测；更新或移动 CLI 后也要检查 |
| 已选 Codex 却仍提示 Claude 错误 | 默认后端只影响新对话。新建 Codex 对话再试，原对话保持原后端 |
| Windows 路径以 .cmd/.ps1 结尾 | 这是启动脚本。让插件重新检测真实 codex.exe，或使用官方原生安装器 |
| Windows CLI 只在 WSL 可用 | 在 Windows 本机单独安装并登录；本插件没有 WSL 启动桥接 |
| 登录失败、额度不足、模型不可用 | 在终端启动对应 CLI 检查账号；模型先用默认或账号可用模型，按服务方提示处理 |
| 已有网页版/桌面 App，插件仍连不上 | 还需安装并登录官方 CLI；在普通终端运行版本命令确认 |
| 网络错误或安装下载失败 | 检查电脑能否访问对应官方服务；公司网络联系管理员；不要用来源不明的安装器替代 |
| CLI 能启动，插件报协议不支持 | 记录 CLI 版本和完整错误，按官方指南更新后重试。不要删除个人 CLI 配置来碰运气 |
| PDF 不能选中文字 | 可能是扫描件。先用文字型 PDF 测试；扫描件需要文字层或额外本地 OCR，基础安装不要求 OCR |
| 梳理完看不到目录 | 先记录是否完成、有无报错；尝试展开“学习目录”，切换文件再回来、重开面板、重启。仍异常按模板反馈 |
| 点选主题后目录收起 | 点击讲解后收起是预期行为。若仅选择主题就收起且无法多选，请反馈具体步骤 |
| 导入 PPT/PPTX 失败 | 先在演示软件里导出 PDF |
| 上下文小圆环显示暂无数据 | 当前后端尚未上报；不是 0%。每个对话保存自己的最近用量，下一次上报后更新 |
| 关掉后找不到记录 | 确认打开了原仓库，并检查原插件目录里的 history.json 和 data.json 是否仍在。先备份，不要覆盖或清空 |
| 彻底删除按钮失败 | 收藏记录需先取消收藏；旧版 Markdown 记录需按提示手动处理。不会连带删除已导出笔记或模型服务方日志 |

## 最短自检

1. 在终端运行所用 CLI 的 `codex --version` 或 `claude --version`，再运行 `codex` 或 `claude` 确认能登录。
2. 重启 Obsidian，核对默认后端、实际 CLI 路径。
3. 新建对话，用一段无敏感内容的 Markdown 测试 Quick Ask。
4. 仍失败，复制错误文字，按 [反馈模板](FEEDBACK.md) 提交 [Issue](https://github.com/Zssan12/obsidian-study-companion/issues)。

安装指南：[Mac](MAC-SETUP.md) · [Windows](WINDOWS-SETUP.md)。不要在公开反馈中上传完整设置、聊天记录、登录文件、密钥或私人课件。
