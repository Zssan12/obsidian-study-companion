# Mac 从零安装

按顺序完成下面六步。命令只复制灰框里的内容，一次执行一行；正常用户不用下载源码或运行 npm。安装命令会下载并执行服务方官方安装器。

## 1. 准备 Obsidian

从 [Obsidian 官网](https://obsidian.md/download) 安装桌面版，打开后新建一个本地仓库，例如 `学习测试`。仓库就是存笔记的文件夹，记住它的位置。插件要求 Obsidian 1.13.0 或更新版本。

## 2. 安装一个 AI 连接程序

**Codex 和 Claude 只选自己有权限使用的一个，不必都装。** 已经能在终端运行并登录对应 CLI 的用户可以跳到第 3 步。

按 `Command + 空格`，搜索“终端”，回车打开。下面的安装命令来自对应官方文档。

### 选 Codex

复制到终端，按回车，等待安装完成：

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

关闭终端窗口，再打开一个新窗口，逐行运行：

```bash
codex --version
codex
```

第一行显示版本号；第二行进入 Codex，按提示选择自己的登录方式并完成浏览器登录。完成后按 `Ctrl + C` 退出。插件连接 CLI，单独安装桌面 App 不能替代这一步。

安装与登录依据：[Codex 官方指南](https://learn.chatgpt.com/docs/codex/cli)。

### 选 Claude

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

安装完成后重开终端，逐行运行：

```bash
claude --version
claude
```

看到版本号后，按 CLI 提示完成自己的账号登录，再按 `Ctrl + C` 退出。需要可用的 Claude Code 服务权限。依据：[Claude 官方安装指南](https://code.claude.com/docs/en/setup)。

如果提示命令不存在，先重开终端；仍不行看安装器给出的 PATH 提示或对应官方安装排查。不要继续猜插件路径，也不要使用 sudo 重复安装。

## 3. 下载并放好插件

1. 打开 [下载页](https://github.com/Zssan12/obsidian-study-companion/releases/latest)。
2. 在 **Assets** 中下载 `study-companion-0.1.0.zip`，不要选 `Source code`。
3. 在 Finder 双击 ZIP 解压。找到里面的 **study-companion** 文件夹。
4. 在 Finder 打开你的笔记仓库文件夹，按 `Command + Shift + .` 显示隐藏文件。
5. 打开 `.obsidian`；没有 `plugins` 文件夹就新建一个。
6. 将解压得到的 **study-companion** 文件夹复制到 `plugins` 里面。

```text
学习测试/.obsidian/plugins/study-companion/main.js
学习测试/.obsidian/plugins/study-companion/manifest.json
学习测试/.obsidian/plugins/study-companion/styles.css
```

找不到仓库：在 Obsidian 文件列表中右键一篇笔记，使用“在系统资源管理器中显示”之类的系统打开入口，在 Finder 中找到所属仓库。若用了自定义配置目录，用它代替 `.obsidian`。

## 4. 启用插件并连接模型

1. 完全退出并重新打开 Obsidian。
2. 设置 → 第三方插件 → 关闭受限模式（部分版本显示为启用第三方插件）→ 打开 Study Companion 开关。
3. 设置左侧找到 **Study Companion**。
4. **新对话默认后端**选择刚安装并登录的 **Codex** 或 **Claude**。
5. 点击 **重新检测 CLI 路径**。只需检查所选后端的路径，另一个留空即可。
6. 模型、回答强度先保留默认；OCR 和实验 PDF 功能先保持关闭。

路径没有自动填上时，在终端运行对应的一行：

```bash
command -v codex
```

或：

```bash
command -v claude
```

把输出的完整程序路径复制到对应 CLI 路径框。不加引号或参数，不使用 `~` 缩写。如果结果是 alias/function，按官方安装器指示找到实际程序。已有错误路径先清空再检测；检测不会覆盖已有内容。

## 5. 确认真的能用

新建笔记，写下“二分查找每次缩小一半搜索范围”，选中这句话 → **Quick Ask** → 输入“用一个生活例子解释” → 发送。能看到回答就完成。

按 `Command + P` 搜索 **开始学习当前资料** 可打开学习面板；打开一份文字 PDF 或 Markdown，点击 **梳理全文**，生成目录后选择主题讲解。刚换后端时请新建对话，已有对话仍用原后端。

## 6. 升级与出错处理

升级前完全退出 Obsidian、备份仓库（包含 `.obsidian`），仅替换插件里的三个运行文件。保留 `data.json`、`history.json` 和自己的资料笔记，不要先卸载。

其他问题见 [故障排查](TROUBLESHOOTING.md)。安装步骤按 2026-10-09 官方文档核对；服务方后续修改安装方式时以官方文档为准，本文不表示所有 CLI 版本都已实机验收。
