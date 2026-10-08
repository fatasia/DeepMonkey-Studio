# SDK 离线安装

SDK 发行包包含 contracts、scene-sdk、server-sdk、deep-engine 的正式 JS/类型归档、固定的 WebGPU 类型和 fflate 压缩依赖，以及八个 3D 模板。解压后先核对 `manifest.json` 的 SHA-256。

项目使用 Node.js 24 和 pnpm 11.18.0。把需要的 `.tgz` 放在项目 `vendor/`，例如：

```json
{
  "private": true,
  "type": "module",
  "dependencies": {
    "@bim-studio/contracts": "file:vendor/bim-studio-contracts-0.2.0.tgz",
    "@bim-studio/scene-sdk": "file:vendor/bim-studio-scene-sdk-0.2.0.tgz",
    "@bim-studio/server-sdk": "file:vendor/bim-studio-server-sdk-0.2.0.tgz"
  }
}
```

项目 `pnpm-workspace.yaml` 把传递依赖固定到同一份本地 contracts：

```yaml
packages: []
overrides:
  '@bim-studio/contracts': file:vendor/bim-studio-contracts-0.2.0.tgz
```

执行 `pnpm install --offline --ignore-scripts`。生产导入解析已安装包的 `dist`；不添加 development condition。渲染 SDK 消费者另安装 `bim-studio-deep-engine-0.2.0.tgz`、`webgpu-types-0.1.72.tgz` 和 `fflate-0.8.3.tgz`，并在上面的 overrides 中添加：

```yaml
  '@webgpu/types': file:vendor/webgpu-types-0.1.72.tgz
  fflate: file:vendor/fflate-0.8.3.tgz
```

八模板版本源在 `templates/deep-engine-3d/references/sdk-versions.json`。

源码发布前生成 SDK 的命令为 `pnpm exec node scripts/export-release-sdk.mjs`，默认输出 `artifacts/releases/0.2.0/DeepMonkey-Studio-SDK-0.2.0.tar.gz`。归档读取已构建的 dist；先完成正式构建，再运行 `pnpm gate:sdk-consumer` 与 `pnpm gate:deep-engine-consumer`。
