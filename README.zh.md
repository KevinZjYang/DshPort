# DshPort

DshPort 是 DeepSeek Harness 的 Windows 便携桌面壳。

这个仓库只保存 DshPort 壳源码、构建脚本和 GitHub Actions。DeepSeek Harness 上游源码不会提交到本仓库；Actions 构建 Release 时会临时拉取上游源码，生成可直接运行的便携包。

## 下载

在 Releases 下载：

- `DshPort-win-x64.zip`：完整 Windows x64 便携包
- `harness-runtime.zip`：仅 Harness runtime 的更新包
- `SHA256SUMS.txt`：校验文件

解压 `DshPort-win-x64.zip` 后运行 `DshPort.exe`。

## 自动发布

GitHub Actions 每 6 小时检测一次上游：

1. 优先读取 `deepseek-ai/deepseek-harness` 的 latest Release；
2. 如果上游没有 Release，则回退查找最新的 `release(dsh): 版本号` 提交；
3. 如果 DshPort 还没有对应版本的 Release，就自动构建并发布；
4. 已有版本不会重复发布，手动运行 workflow 且 `force=true` 时除外。

## 本地构建

```sh
pnpm install --frozen-lockfile
node scripts/build-runtime.mjs
node scripts/package.mjs --zip
```

产物位于 `dist-exe/desktop`。

## 数据

便携包运行时把用户数据保存在程序目录旁的 `data/` 下。更新程序文件时不会覆盖 `data/`。
