# DshPort

DshPort 是 DeepSeek Harness 的 Windows 便携桌面壳。

这个仓库只保存 DshPort 自己的壳源码、构建脚本和 GitHub Actions。上游 DeepSeek Harness 源码不会提交到本仓库；发布时由 GitHub Actions 临时拉取上游源码，构建出可直接运行的便携包并上传到 Release。

## 下载哪个

第一次使用下载：

- `DshPort-win-x64.zip`

解压后双击 `DshPort.exe` 即可运行。

另外两个文件的用途：

- `harness-runtime.zip`：仅 Harness 运行时更新包，主要给后续自动更新或增量更新用
- `SHA256SUMS.txt`：校验下载文件是否完整

## 版本规则

DshPort 使用自己的 Release 版本号，例如：

- `v0.1.0`
- `v0.1.1`
- `v0.1.2`

上游 DeepSeek Harness 的版本号不会直接作为 DshPort 的 Release tag。比如上游提交是 `release(dsh): 0.1.0-rc.5`，DshPort 会在 Release 说明里记录“上游版本：0.1.0-rc.5”，但 DshPort 自己的发布版本仍然使用 `v0.1.0` 这类正式版本号。

## 自动发布

GitHub Actions 每 6 小时检测一次上游：

1. 优先读取 `deepseek-ai/deepseek-harness` 的 latest Release；
2. 如果上游没有 Release，则查找最新的 `release(dsh): 版本号` 提交；
3. 如果这个上游版本还没有被 DshPort 发布过，就自动构建；
4. 自动生成新的 DshPort Release，并上传完整便携包、运行时更新包和校验文件。

每个 Release 的说明会自动带上“更新内容”一节：

- 先列出 **Harness 版本变化**（上次发布内置的 `@deepseek-ai/dsh` 版本 → 本次版本，例如 `0.1.0-rc.5 → 0.1.0-rc.6`）；如果与上次相同会注明“与上次发布相同”。
- 再列出自上一个 DshPort 版本以来的提交记录（含提交链接）。

如果两次发布之间 DshPort 没有新提交（例如仅 Harness 版本更新），会注明“本次没有新的 DshPort 提交”。

也可以在 GitHub Actions 页面手动运行 workflow，指定上游 ref 或 DshPort 发布版本。

## 应用内更新

DshPort 启动时会检查 `KevinZjYang/DshPort` 的最新 Release；窗口顶部也有“检查更新”按钮，工具栏右侧会显示检查结果与下载进度。

- **下载前确认**：发现新版本时先询问是否下载（显示版本号与大小），不会在后台静默下载大更新包。
- **下载进度**：下载期间工具栏显示进度条和百分比；安装时进度窗口同步显示百分比。
- **安装选择**：下载完成后可“立即安装”、“稍后（24 小时后提醒）”或“忽略此版本”。选择“忽略此版本”后该版本不再提示（记录在 `data/settings.json`）。
- **下载代理**：更新包直连 GitHub 失败时，会自动改用代理 `https://gh.yiun.cyou/` 重试（把原始下载地址拼在代理域名后）。可用环境变量 `DSH_UPDATE_PROXY` 自定义代理，设为 `0` 或 `off` 可禁用。
- 安装时会替换程序文件，`data/` 下的配置、会话和工作区会保留。

## 托盘运行

- 点击窗口关闭按钮会把窗口最小化到系统托盘，应用与 Harness 继续在后台运行；点击托盘图标恢复窗口。
- 托盘右键菜单提供：显示主窗口、任务完成通知、重启 Harness、检查更新、备份/恢复数据、打开数据/日志目录、退出。
- 从托盘“退出”时会先确认，避免误关导致 Harness 停止。

## 任务完成通知

当 Harness 中的 agent 任务（会话运行）结束时，即使窗口最小化到托盘或切到后台，也会弹出 Windows 通知，点击通知可回到主窗口：

- 实现方式：DshPort 每 2 秒通过 Harness 自带的 `session.list` API 轮询一次会话状态，检测到正在运行的会话结束后即弹出通知（仅顶层会话，子任务完成不打扰）。
- 开关：托盘菜单中的“任务完成通知”复选框（默认开启，状态记录在 `data/settings.json` 的 `taskNotifications` 字段）。
- 窗口在前台时不会弹出通知，避免干扰正在查看的内容。

## 数据管理

工具栏“数据管理”按钮（或托盘菜单）提供：

- **备份数据**：把**工作区（`workspace/`）与模型设置（`dsh-home/`，含 API 凭据、配置与历史会话）**打包为 zip 保存到指定位置；日志、更新包与应用自身设置不包含在内。
- **恢复备份**：选择备份 zip 后，会先停止 Harness、用备份内容**覆盖合并**工作区与模型设置（日志、更新文件保留），再自动重启 Harness；恢复前会二次确认。
- 已忽略的更新版本等设置存放在 `data/settings.json`，不在备份范围内。

## 快捷方式

DshPort 是便携应用，没有安装器。可以手动创建桌面/开始菜单快捷方式：

- 点击工具栏“创建快捷方式”按钮或托盘菜单中的“创建快捷方式”，选择位置（桌面 / 开始菜单 / 两者）。
- 首次启动时会询问一次是否创建桌面快捷方式（选择后不再询问）。
- 快捷方式指向 `DshPort.exe`，工作目录为便携根目录，`data/` 数据不受影响。
- 注意：移动 DshPort 文件夹后快捷方式会失效，重新创建一次即可。

## 本地构建

```sh
pnpm install --frozen-lockfile
node scripts/build-runtime.mjs
node scripts/package.mjs --zip
```

产物位于 `dist-exe/desktop`。

## 用户数据

便携包运行时会把用户数据保存在程序目录旁的 `data/` 下。更新程序文件时不会覆盖 `data/`。
