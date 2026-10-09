# Study Companion · 学习伴侣

在 Obsidian 里边读资料边问 AI。支持 Markdown、PDF、按目录学习、独立追问、离线英汉词典和批量课件讲解。

**普通用户直接下载安装包，无需编译，也不用安装项目依赖。Mac 和 Windows 使用同一个 ZIP。**

[下载安装包](https://github.com/Zssan12/obsidian-study-companion/releases/latest) · [Mac 从零安装](docs/installation/MAC-SETUP.md) · [Windows 从零安装](docs/installation/WINDOWS-SETUP.md) · [使用说明](docs/user-guide.md) · [常见问题](docs/installation/TROUBLESHOOTING.md)

## 让 AI 帮你安装

如果你正在使用能操作本机文件和终端的 Codex、Claude Code 等 AI 助手，可以直接复制下面这段提示词给它。普通网页聊天无法直接完成本机安装，请使用后面的手动安装步骤。

```text
请帮我在这台电脑上安装并配置 Obsidian 的 Study Companion 插件，直到能正常提问。
项目：https://github.com/Zssan12/obsidian-study-companion

先阅读项目 README 和 docs/installation/ 下对应系统的安装指南，再按实际环境操作：
1. 检查操作系统、Obsidian 版本，以及是否已有可用的 Codex CLI 或 Claude Code CLI。优先复用已安装的 CLI；需要安装时使用官方安装方式，并核对最新官方说明。只有桌面 App 不代表已安装 CLI。
2. 确认要安装到哪个 Obsidian 笔记仓库，以及是否使用自定义配置目录。路径不明确或有多个候选时先问我，不要猜。若需要选择或新装 CLI，先确认我有哪个服务的使用权限。浏览器登录由我本人完成，不要读取或输出登录凭据。
3. 从该仓库 Releases 下载最新正式发布的插件 ZIP 和对应 SHA-256 校验文件，校验通过后解压。使用现成安装包，不要下载 Source code 或编译项目。
4. 在修改插件文件前让我保存笔记并完全退出 Obsidian。首次安装，将包里的 study-companion 文件夹放入目标仓库的配置目录/plugins/ 下，确认 main.js、manifest.json、styles.css 没有多套一层目录。若已安装，先备份，再仅替换这三个运行文件；保留 data.json、history.json、所有笔记和附件，不要卸载插件或清空目录。
5. 重新打开 Obsidian，在设置 → 第三方插件中关闭受限模式并启用 Study Companion，将“新对话默认后端”设为已安装并登录的 CLI，再点击“重新检测 CLI 路径”。已有错误路径先清空再检测。路径使用实际程序的完整路径；Windows 需要本机 .exe，不要填写 .cmd、.ps1 或 WSL 路径。模型和回答强度先保留默认。
6. 用一篇新建测试笔记验证：写入“二分查找每次缩小一半搜索范围”，选中文字打开 Quick Ask，发送“用一个生活例子解释”。确认收到回答后再报告安装成功。

能直接完成的步骤请执行。遇到需要我登录、选择仓库或操作界面的步骤，用简短中文告诉我具体怎么做；如果你无法控制 Obsidian 界面，就指导我点击并等待结果。失败时先查原因，不要靠删除数据或反复重装解决。最后列出安装位置、插件版本、所选 CLI，以及实际验证结果或尚未完成的步骤。
```

## 手动安装

1. 安装 [Obsidian 桌面版](https://obsidian.md/download)，版本需为 1.13.0 或更新，创建并打开一个本地仓库（也就是存放笔记的文件夹）。
2. 安装并登录 **Codex CLI 或 Claude Code CLI，二选一即可**。具体操作见 [Mac 安装指南](docs/installation/MAC-SETUP.md) 或 [Windows 安装指南](docs/installation/WINDOWS-SETUP.md)。CLI 是连接模型的本机程序，只有网页或桌面 App 不够。
3. 打开 [Releases 下载页](https://github.com/Zssan12/obsidian-study-companion/releases/latest)，在 **Assets** 下下载 `study-companion-0.1.0.zip`。不要下载 GitHub 自动生成的 `Source code`。
4. 解压，将里面的 `study-companion` 文件夹放进你的仓库的 `.obsidian/plugins/`。
5. Obsidian → 设置 → 第三方插件 → 关闭受限模式 → 启用 **Study Companion**。
6. 设置 → Study Companion → **新对话默认后端**：选刚安装的 Codex 或 Claude → **重新检测 CLI 路径**。模型和回答强度先用默认。
7. 新建一篇笔记，写一句话，选中后点击 **Quick Ask**，再点发送。收到回答就完成了。

正确的文件位置如下，不能多套一层文件夹：

```text
你的笔记仓库/
  .obsidian/
    plugins/
      study-companion/
        main.js
        manifest.json
        styles.css
```

找不到 `.obsidian`、路径为空、没有回答时，按对应平台教程里的排查步骤操作。首次试用建议单独建一个测试仓库。

## 包含哪些功能

| 想做什么 | 如何使用 |
| --- | --- |
| 一边阅读一边提问 | 选中 Markdown、PDF 或历史回答里的文字，打开 Quick Ask，确认后发送 |
| 像普通聊天一样提问 | 输入区切到普通模式，资料切换不会改变当前普通对话 |
| 按课件目录学习 | 学习模式打开资料，点击梳理全文；Markdown 还支持梳理选区 |
| 继续或重新安排学习 | 多选主题后讲解，目录支持重新梳理，每份资料保留独立进度 |
| 查英文单词 | 选中英文显示离线中文释义，支持词形及部分漏字补全，不调用模型 |
| 批量整理 PDF 课件 | 右上角闪电打开“突击”，多选 PDF，生成讲解与总目录 |
| 收藏、整理笔记 | 回答旁点星标；在收藏或整理入口预览后保存为 Markdown |
| 给模型补充材料 | 输入区 ＋、拖入文件或粘贴图片 |
| 看历史与用量 | 历史入口查看记录；每个对话分别保存上下文用量，重启后恢复最近上报值 |
| 清空或彻底删除聊天 | 右上角 ⋯ 清空当前对话；历史的已删除区域可恢复或再次确认彻底删除 |
| 检索笔记、查网页 | 按设置范围和问题需要调用，显示工具活动与来源 |

完整操作与限制见 [使用说明](docs/user-guide.md)。

## 账号、费用与隐私

插件本身不提供账号或模型额度。请使用自己已登录、具有服务权限的官方 CLI；实际费用和额度按所选服务执行。无需把 API key 或登录文件发给作者，也无需在插件里填写密钥。

提问时，问题、所需资料片段和相关历史会发送给你选择的模型服务。英文离线查词不联网、不调用模型。插件没有遥测；不会因为打开一份资料就自动调用模型。详见 [隐私说明](PRIVACY.md)。

## 升级和备份

先完全退出 Obsidian，备份自己的仓库（包括隐藏的 `.obsidian`），再用新版包里的 **main.js、manifest.json、styles.css** 覆盖同名文件。只替换这三个文件。

**保留 `data.json` 和 `history.json`**，它们保存设置、学习状态和聊天记录。也保留资料、附件、已导出笔记和旧版 Markdown 历史。不要先卸载插件或清空旧插件文件夹。自定义配置目录的用户使用自己的配置目录代替 `.obsidian`。

## 当前支持范围

- 版本 0.1.0，桌面端，界面以简体中文为主；发布包无 dev / beta 文件名后缀，保留现有完整功能。
- GitHub 手动安装；尚未在 Obsidian 社区插件商店上架。
- 有 macOS 历史开发验证及自动化回归；**Windows 实机完整验收仍未完成**。发布版本号不代表所有平台已通过实机测试。
- 手机和平板暂不支持；PPT/PPTX 先导出为 PDF。扫描 PDF 需要文字层、可选本地 OCR 或受支持的图文流程。
- 不支持把 Quick Ask 自动合并进主线，也不保证跨设备恢复 CLI 原始会话。模型解释和引用内容仍需自行核对。

## 遇到问题

先看 [故障排查](docs/installation/TROUBLESHOOTING.md)。仍有问题，请到 [Issues](https://github.com/Zssan12/obsidian-study-companion/issues) 按 [反馈模板](docs/installation/FEEDBACK.md) 提交；不要上传账号信息、私人笔记或完整 `data.json` / `history.json`。

## 开发者

以下命令只用于开发；下载安装包的用户跳过。需要 Node.js 22 或更新版本。

```bash
npm ci
npm run check
npm run release:check
npm run package
```

包输出到 `artifacts/` 下独立构建目录；终端显示 ZIP 路径。源码与插件三件套、Mac/Windows 指南分开管理。发布流程同时上传 ZIP、SHA-256 校验文件和 Obsidian 三件套。

[架构](ARCHITECTURE.md) · [贡献指南](CONTRIBUTING.md) · [发布检查](docs/release-readiness.md) · [更新日志](CHANGELOG.md) · [安全](SECURITY.md)

本项目原创代码采用 [MIT](LICENSE)；随包组件和词典保留各自的 [第三方条款](THIRD_PARTY_NOTICES.md)。本项目并非 Obsidian、OpenAI 或 Anthropic 官方产品。
