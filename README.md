# DshPort

DshPort is a portable Windows desktop shell for DeepSeek Harness.

This repository contains only the DshPort shell, packaging scripts, and GitHub Actions. The upstream DeepSeek Harness source is not committed here. Release builds fetch the upstream source temporarily and publish portable archives as release assets.

## Releases

Download these files from Releases:

- `DshPort-win-x64.zip`: complete Windows x64 portable package
- `harness-runtime.zip`: Harness runtime-only update package
- `SHA256SUMS.txt`: SHA-256 checksums

Unzip `DshPort-win-x64.zip` and run `DshPort.exe`.

## Automated Builds

GitHub Actions checks upstream every 6 hours:

1. Prefer the latest GitHub Release from `deepseek-ai/deepseek-harness`.
2. If upstream has no releases, fall back to the newest `release(dsh): version` commit.
3. Build and publish a DshPort Release when the matching release tag does not exist.
4. Manual workflow runs can rebuild with `force=true`.

## Local Build

```sh
pnpm install --frozen-lockfile
node scripts/build-runtime.mjs
node scripts/package.mjs --zip
```

Build output is written to `dist-exe/desktop`.
