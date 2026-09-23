# 开源素材交付审计（2026-09-23）

这份审计回答一个实际问题：用户从 GitHub clean clone 后，启动 Deep Monkey Studio 能立即看到哪些模板和素材，哪些资源需要另行同步，以及 Docker/离线部署应如何打包。

机器校验入口：

```bash
pnpm assets:verify:open
```

脚本是只读的，不下载文件、不修改 `data/`，并校验随仓库资产的文件存在性、Git 跟踪状态、目录清单和 SHA-256：[`scripts/verify-open-asset-delivery.mjs`](../../scripts/verify-open-asset-delivery.mjs)。结构化结果见[交付 manifest](open-asset-delivery-manifest-2026-09-23.json)，当前结果为 `passed`。

## clean clone 后开箱可用

| 资源 | 位置 | 交付方式 | 授权/状态 | 当前事实 |
| --- | --- | --- | --- | --- |
| Nature Kit 3D 环境模型 | `apps/web/public/assets/nature-kit/` | 随 Web 静态包和 Git 交付，API 无需外部目录即可回退加载 | Kenney Nature Kit 2.1，CC0 | 48 个 GLB、192 个四视图缩略图、`catalog.json` 与 `License.txt`；目录逐文件校验 |
| 行业看板模板 | `apps/web/src/components/dashboardTemplateCatalog.ts` 及其域/布局文件 | TypeScript 编译进 Web bundle | 自有代码，按仓库 LICENSE 发布 | 测试断言 317 个模板；不依赖模型下载 |
| 二维看板组件和装饰 | `apps/web/src/components/dashboardWorkspaceModel.ts`、`DashboardComponentCatalog.ts` | TypeScript 编译进 Web bundle，实例保存到场景文档 | 自有代码 | 组件定义、属性编辑和拖放链路随 Web 交付 |
| 行业模板包和样例数据 | `apps/web/src/components/industryTemplatePackCatalog.ts` 及 `industryPack*` | TypeScript 编译进 Web bundle | 自有代码 | 制造、物流、电力、水务包由目录注册并在启动时求值 |
| 视觉推理样例 | `apps/api/assets/vision-sample/` | 随 API 镜像/源码交付，不启动下载 | YOLOX 官方样例，Apache-2.0，目录内有完整许可 | ONNX 权重和 `dog.jpg` 的 SHA-256 已写入 README |
| Deep Engine Lab 渲染样例 | `packages/deep-engine/lab/assets/` | 随源码和测试包交付 | 每个样例有上游 LICENSE/metadata | `sources.json` 固定上游 commit、大小、SHA-256；仅用于开发和验证 |
| 电池推理模型 | `apps/api/models/battery/` | 随 API 源码/镜像交付，运行时按功能加载 | 以目录 README 和上游许可为准 | ONNX、F32 和 runtime adapter 均被 Git 跟踪；不是三维素材库 |

Nature Kit 的 API 路由默认目录是 `apps/web/public/assets/nature-kit/`；因此在无 `data/` 的新环境中，Nature Kit 仍可在素材库中列出和导入。模板、二维组件和行业包是代码目录，不能从服务器文件系统删除后再期待 API 发现它们；它们随 Web bundle 一起发布。API 启动只登记目录路径，不预加载或下载素材；首次 `GET /api/asset-library` 才惰性读取各目录 catalog/audit，后续请求按文件变化刷新缓存。电池模型只在对应推理功能启用时加载。

## clean clone 后默认没有的资源

`.gitignore` 排除了整个 `data/`。以下目录在开发机可能存在，但不会进入 GitHub，也不会自动进入开源 Docker 镜像：

| 资源 | 默认路径 | 需要的动作 | 原因 |
| --- | --- | --- | --- |
| 开放扩展包（城市、工厂、车辆、人物、VFX、声音等） | `data/external-assets/open-packs/` | `pnpm assets:sync:open-packs`，再按目录逐包做许可/质量审计 | ZIP 体量和来源版本变化，不应隐式塞进源码镜像 |
| 外部工业模型库 A | `data/external-assets/source-a/`，可用 `ASSET_LIBRARY_DIR` 覆盖 | 在拥有再分发权的环境中同步 `catalog.json`、`audit.json` 和模型文件 | 外部模型可能含署名、品牌和客户数据；默认 `review-required` |
| 外部社区模型库 B | `data/external-assets/source-b/` | 先同步、审计、去重、生成 catalog/audit，再挂载 | 不满足许可证或质量审计时 API 会拒绝导入 |
| 环境材质库 | `data/external-assets/environment-materials/` | `pnpm assets:sync:environment-materials`，再挂载到 API 数据目录 | 可选库，不是 Web 静态包的一部分 |
| 工业格式验收样本（RVT/JT/X_T/E57/点云/3D Tiles 等） | `data/external-assets/format-fixtures/` | 仅在开发/CI 验收机准备 | 样本授权和体量不适合随产品发布，不能冒充用户素材 |

API 的 `assetLibraryDir` 默认值是 `data/external-assets/source-a`。目录缺失时服务仍能启动，但工业模型列表为空；这不是“素材库坏了”，而是可选外部库未安装。`/api/asset-library` 会把目录不可用报告为可操作的离线目录错误。

## 交付规则

1. **核心 UI 资源随包交付。** 模板、二维组件、行业样例和 Nature Kit 属于开源产品的可复现基线，必须随源码或镜像发布，并有固定目录清单和许可文件。
2. **外部模型按独立资源包交付。** 每个包包含 `catalog.json`、`audit.json`、原始来源、许可证、SHA-256 和版本；Docker 用只读 volume 挂载，不把客户或未经审计的模型复制进镜像。
3. **用户项目资产与产品素材分离。** 用户上传模型进入 `DATA_DIR`/对象存储，由项目记录引用；不能把运行时用户数据提交 Git，也不能把演示模型误标为公共素材。
4. **启动不联网。** 开源安装的默认路径只使用 Git 中的核心资源。同步脚本是显式动作，网络失败不会悄悄改变产品目录。
5. **每次发布先运行清单验证。** `pnpm assets:verify:open` 必须通过；若新增包，补充来源、授权边界、哈希和可复现同步命令。

## Docker 交付建议

核心镜像可以做到“一键启动”：构建阶段安装依赖、构建 Web/API，并复制 `apps/web/public/assets/nature-kit`、`apps/api/assets/vision-sample`、Lab fixtures 和代码模板；运行阶段通过 `DATA_DIR=/var/lib/bim-studio` 保存用户项目。外部素材不要写死进镜像，采用：

```yaml
volumes:
  - ./data:/var/lib/bim-studio
  - ./asset-packs:/opt/bim-studio/assets:ro
environment:
  DATA_DIR: /var/lib/bim-studio
  ASSET_LIBRARY_DIR: /opt/bim-studio/assets/source-a
```

这样，镜像 digest、核心素材 hash 和用户数据生命周期彼此独立；用户可以只拉取轻量核心镜像，也可以按授权挂载工业资产包。完整 Docker 工作量评估和 compose/健康检查应在发布收口阶段单独落地，不能把 `data/` 工作机快照直接复制进镜像。

## 证据与限制

- 本次 manifest 记录仓库 Git 跟踪 7,282 个文件；按模型/媒体/目录清单相关扩展统计 464 个文件、112,222,056 字节。主要类型包括 55 个 GLB、210 个 PNG、6 个 ONNX、2 个 F32、2 个 MP4 和 8 个 SVG；其中 48 个 Nature Kit GLB、7 个 Lab GLB 的用途和许可证不同，不能混为产品素材库。该统计按扩展名列出，JSON 同时包含产品目录和样例清单，不等同于可导入的模型数。
- 当前工作机上的五类 `data/external-assets/` 缓存目录均存在，但 Git 跟踪数均为 0；clean clone 不包含这些本地缓存。manifest 的 `presentOnDisk` 描述生成时机器状态，`gitTrackedFiles` 才是仓库交付事实。
- `pnpm assets:verify:open` 与 `pnpm assets:audit:test` 均通过；后者 24 项通过。单独的 manifest gate 测试 1 项通过。
- Nature Kit 的源包和派生准入证据见 [`docs/reports/de26-v11-nature-audit-2026-09-18.md`](de26-v11-nature-audit-2026-09-18.md) 与 [`docs/specs/de26-v11-kenney-nature-admission-manifest-2026-09-18.json`](../specs/de26-v11-kenney-nature-admission-manifest-2026-09-18.json)。
- `data/` 当前开发机中的文件不代表 GitHub 用户能获得的文件；审计脚本只把 Git 跟踪、公开目录和可验证目录列为开箱能力。
