# Windows 从零安装

不需要编译、不需要 WSL，也不必安装 Node.js。以下默认用官方原生 CLI 安装器；已有 npm 安装的排查见文末。命令只复制灰框内容，一次执行一行。

## 1. 准备 Obsidian

从 [Obsidian 官网](https://obsidian.md/download) 安装桌面版，版本需为 1.13.0 或更新。新建并打开一个本地仓库，例如 `学习测试`，记住存放位置。仓库就是存笔记的文件夹。

## 2. 安装一个 AI 连接程序

Codex、Claude **二选一**，选择你已有服务权限的那个。开始菜单搜索 **PowerShell** 并打开普通窗口，无需管理员窗口。下面的安装命令会下载并执行对应服务方的官方安装器。

### 选 Codex

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

等待完成，关闭窗口，重新打开 PowerShell，逐行执行：

```powershell
codex --version
codex
```

第一行应显示版本号；第二行按提示选择登录方式，在浏览器完成自己的账号登录，返回后按 `Ctrl + C` 退出。上面的 ByPass 仅用于这次安装进程，不要求你永久放宽系统执行策略；公司电脑被策略阻止时联系管理员。

依据：[Codex 官方安装指南](https://learn.chatgpt.com/docs/codex/cli)。只装桌面 App 或 WSL 里的 Codex 不够，本插件需要 Windows 本机可执行程序。

### 选 Claude

```powershell
irm https://claude.ai/install.ps1 | iex
```

等待完成，关闭并重新打开 PowerShell，逐行执行：

```powershell
claude --version
claude
```

看到版本号后，按 CLI 提示完成自己的账号登录，再按 `Ctrl + C` 退出。依据：[Claude 官方安装指南](https://code.claude.com/docs/en/setup)。如果安装器报告依赖或网络问题，按其提示及官方排查处理。

如果提示命令不存在，先重开 PowerShell；仍不行，查看安装器的 PATH 提示。只有 CLI 在本机正常启动并登录后，再继续配置插件。

## 3. 下载并放好插件

1. 打开 [下载页](https://github.com/Zssan12/obsidian-study-companion/releases/latest)。
2. 在 **Assets** 中下载 `study-companion-0.1.0.zip`，不要下载 `Source code`。
3. 右键 ZIP → **全部解压缩**。不要直接在压缩包窗口里操作。
4. 用资源管理器打开自己的笔记仓库。在地址栏末尾加上 `\.obsidian` 并回车，即可进入配置目录。
5. 没有 `plugins` 文件夹就新建一个；把解压后的 **study-companion** 文件夹复制进去。
6. 检查文件层级如下：

```text
学习测试\.obsidian\plugins\study-companion\main.js
学习测试\.obsidian\plugins\study-companion\manifest.json
学习测试\.obsidian\plugins\study-companion\styles.css
```

不能多套一层 `study-companion` 或 ZIP 名称的文件夹。找不到仓库时，在 Obsidian 右键一篇笔记，使用系统资源管理器打开入口定位；如果自定义过配置目录，用它代替 `.obsidian`。

## 4. 启用并配置

1. 完全退出并重新打开 Obsidian。
2. 设置 → 第三方插件 → 关闭受限模式（或启用第三方插件）→ 启用 **Study Companion**。
3. 设置 → **Study Companion** → **新对话默认后端**，选 Codex 或 Claude。
4. 点击 **重新检测 CLI 路径**，对应路径应自动填入。另一个后端可以留空。
5. 模型和回答强度先保留默认，先不开 OCR 和实验 PDF 功能。

如果没有自动填入，在 PowerShell 执行对应命令：

```powershell
Get-Command codex -All | Select-Object CommandType, Source
```

或：

```powershell
Get-Command claude -All | Select-Object CommandType, Source
```

将输出中实际 `.exe` 的完整路径填入对应 CLI 路径框，不加引号或参数。已有错误路径先清空，再检测。不要填写 `wsl.exe`、Linux 路径、整条启动命令或快捷方式。

## 5. 发出第一条问题

新建笔记，写下“二分查找每次缩小一半搜索范围”，选中这句话 → **Quick Ask** → 输入“用一个生活例子解释” → 发送。看到回答说明基础配置成功。

按 `Ctrl + P` 搜索 **开始学习当前资料**，打开学习面板。打开文字型 PDF 或 Markdown → **梳理全文** → 选择主题 → 讲解。更换默认后端后要新建对话，已有对话会继续使用原后端。

## 6. 已通过 npm 安装的用户

不用重复安装。若 `Get-Command` 显示 `codex.cmd` 或 `codex.ps1`，这是启动脚本，**不能直接填入插件**。插件会在常见 npm 安装目录查找真正的 `codex.exe`：清空错误路径，完全重启 Obsidian，再点检测。仍找不到时记录安装方式和版本后反馈，或改用上面的官方原生安装器。

若 PowerShell 提示 `codex.ps1` 被执行策略阻止，已有 npm 安装可用 `codex.cmd --version` 和 `codex.cmd` 检查并登录；插件里仍需填 `.exe`。无需永久修改执行策略。

## 升级与已知限制

完全退出 Obsidian并备份仓库（含 `.obsidian`），只覆盖 `main.js`、`manifest.json`、`styles.css`。保留 `data.json`、`history.json`、资料和笔记，不要清空旧文件夹。

Windows 实机完整验收尚未完成。已有路径自动化测试不等于每台 Windows 都通过；如果目录不显示，先按 [故障排查](TROUBLESHOOTING.md) 留下现象，不要先删除数据或重复生成。

安装步骤按 2026-10-09 官方文档核对。后续安装变化以官方文档为准。
