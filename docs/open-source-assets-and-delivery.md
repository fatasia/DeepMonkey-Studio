# 开源素材与交付

这份入口说明 GitHub clean clone、系统文档中心和 Docker 镜像分别携带什么。

- 随仓库交付：Nature Kit（48 个 GLB、192 个缩略图、目录和 CC0 许可）、看板模板、二维组件、行业模板代码、公开样例和 Deep Engine Lab 测试素材。
- 按需交付：工业模型库、环境材质、格式验收样本和客户项目数据位于被 Git 忽略的 `data/`，不会因 clone 自动出现。
- 字体：当前没有跟踪的 `.ttf`、`.otf`、`.woff` 或 `.woff2` 文件，运行时使用系统字体和浏览器字体栈；新增字体必须附来源、许可证和哈希。
- 模型：随仓库的 Nature Kit、YOLOX 视觉样例、电池推理模型和 Lab 样例均有目录说明、来源或许可证、哈希校验；外部模型必须独立资源包交付。

验证命令：

```bash
pnpm assets:verify:open
pnpm assets:audit:test
```

经过授权审计的素材包使用 `pack.manifest.json` 描述版本、许可证、发布状态和每个文件的 SHA-256，并同时携带 `catalog.json`、`audit.json`。导入本地目录或 MinIO 挂载目录：

```bash
pnpm assets:import -- ./packs/open-library.zip --target=./data/external-assets/source-a
```

导入采用临时目录、路径越界检查、哈希校验和原子替换；`publicationStatus` 不是 `published` 或清单不完整时会拒绝。MinIO 部署只需把 `ASSET_LIBRARY_DIR` 指向挂载的素材目录，API 会从同一目录读取目录和文件，项目导入时再写入 MinIO 对象存储。素材包不会把客户模型、内部使用模型或未审计外部缓存变成公开内容。

详细清单见 [`docs/reports/open-asset-delivery-audit-2026-09-23.md`](reports/open-asset-delivery-audit-2026-09-23.md)。系统文档中心的同名文章是 `open-source-assets`，Wiki 由 `apps/web/src/docs` 生成：

```bash
pnpm docs:wiki:check
pnpm docs:wiki:export -- --out-dir ./wiki-export
```
