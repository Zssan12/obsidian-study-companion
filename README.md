# Study Companion · 学习伴侣

在 Obsidian 里边读资料边问 AI。支持 Markdown、PDF、按目录学习、独立追问、离线英汉词典和批量课件讲解。

**普通用户直接下载安装包，无需编译，也不用安装项目依赖。Mac 和 Windows 使用同一个 ZIP。**

[下载安装包](https://github.com/Zssan12/obsidian-study-companion/releases/latest) · [Mac 从零安装](docs/installation/MAC-SETUP.md) · [Windows 从零安装](docs/installation/WINDOWS-SETUP.md) · [使用说明](docs/user-guide.md) · [常见问题](docs/installation/TROUBLESHOOTING.md)

## 第一次安装，按这个顺序

1. 安装 [Obsidian 桌面版](https://obsidian.md/download)，版本需为 1.13.0 或更新，创建并打开一个本地仓库（也就是存放笔记的文件夹）。
2. 安装并登录 **Codex CLI 或 Claude Code CLI，二选一即可**。不确定怎么装，直接打开上面的 Mac / Windows 教程，从第一步跟着做。CLI 是连接模型的本机程序，只有网页或桌面 App 不够。
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
