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

也可以在 GitHub Actions 页面手动运行 workflow，指定上游 ref 或 DshPort 发布版本。

## 应用内更新

DshPort 启动时会检查 `KevinZjYang/DshPort` 的最新 Release；窗口顶部也有“检查更新”按钮。发现新版本后，用户确认即可下载 `DshPort-win-x64.zip` 并替换程序文件，`data/` 下的配置、会话和工作区会保留。

## 本地构建

```sh
pnpm install --frozen-lockfile
node scripts/build-runtime.mjs
node scripts/package.mjs --zip
```

产物位于 `dist-exe/desktop`。

## 用户数据

便携包运行时会把用户数据保存在程序目录旁的 `data/` 下。更新程序文件时不会覆盖 `data/`。
