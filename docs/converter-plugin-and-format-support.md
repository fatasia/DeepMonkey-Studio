# 转换插件合同与真实格式支持

## 定位

模型导入仍以现有资源库为入口。`ConverterPlugin` 是 M5 新增的轻量扩展边界，用于把需要原生 SDK、许可证或独立进程的格式移出 API 主进程；它不是一套新的重型 CAD 平台。

插件清单必须声明版本、输入格式、结构化输出、运行位置、最小权限与资源上限。任务只允许读取当前项目的输入对象，并将产物写入 `projects/{projectId}/conversions/{taskId}/output/`。同一输入哈希、插件版本和配置后续可作为确定性缓存键。

## 当前真实支持

| 输入 | 当前处理方式 | 运行时产物/查看方式 | 真实状态 |
| --- | --- | --- | --- |
| IFC | 保留源文件 | 浏览器转 Fragments | 可用 |
| glTF | 保留源文件 | Three.js glTF 查看 | 可用 |
| GLB | 服务端优化并按规模生成 LOD | 优化 GLB | 可用 |
| FBX | 保留源文件 | Three.js FBX 查看 | 可用 |
| DXF | 保留源文件 | 二维 DXF 查看 | 可用 |
| STEP / STP | `occt-import-js` 解析与三角化 | GLB + hierarchy.json + properties.json | 可用 |
| DWG | 外部 LibreDWG 命令 | DXF | 配置转换器后可用，否则 `waiting_converter` |
| RVT | Windows Revit Agent / Revit Add-in | IFC 或原生 GLB，可带层级与属性 | 配置转换器且存在兼容 Revit 后可用 |
| Parasolid X_T | TypeScript 内部严格子集 | 命中 V24.1 单体共轴旋转件时为 GLB + 层级 + 属性;否则仅 inspection | 单份 MIT 真实样本 L2 通过;不等于通用 X_T |
| Parasolid X_T（通用降级档） | 同一 Provider 内 fallback 到 `packages/xt-reader` 通用文本解析（校验门控，108 个真实样本解析回归见 `test-output/xt-generic-parser-regression-20260925.json`） | 子集档拒绝且通用解析发布出 ≥1 网格时为 GLB + 层级 + 属性（`visual-complete`，losses 逐条来自 xt-reader）；0 个可发布面片（含 legacy-baseline 编码）保持 `waiting_converter` 并在 inspection 记录 generic-parse census，绝不 ready 空几何 | 平面/圆柱/圆锥/球面族按证据发布；trim、实体名称/颜色、装配挂接与 legacy-baseline 编码如实进损失，不冒充完整 B-Rep |
| Parasolid X_B | 内置阻断(等待内置 B-Rep 离散化),不依赖商业 Provider | `waiting_converter` + 检查证据 | 解析层可行:`parasolid-kit` v0.2.0(MIT,`parasolid-core`)已提供 X_B 严格解析与 B-Rep 映射,须逐文件审计、固定版本、随包交付;几何发布缺少 B-Rep 三角化(自研,属 R1 工程量)。在离散化落地前,X_B 保持明确阻断,不接入任何商业转换器 |
| JT | TypeScript 内部 JT 9.5/10 TriStrip/TopoMesh 子集 | 最高精度 LOD0 GLB + hierarchy/properties/inspection | JT 9.5 与 10.3 各一份真实样本 L2 通过；不支持的版本或无 LOD0 时 `waiting_converter` |
| OpenUSD / USDA / USDC / USDZ | Three.js 0.185.1 官方 USDLoader 按需解析 | 保留并直接查看源文件 | USDA/USDC/USDZ 官方样本已通过；复杂 composition 仍需样本验证 |

因此不能表述为“所有格式都会转为 GLB”。直接查看格式继续保留源格式；需要三角化或原生宿主导出的格式才优先生成 GLB。

转换器输出不会因为文件名为 `geometry.glb` 就被接受。API 会在发布前解析 GLB，确认至少存在一个带 POSITION 顶点的三角网格，并校验已生成的 `hierarchy.json`、`properties.json`、`pmi.json` 为 JSON 对象；JT 与 Parasolid 还必须提供 `hierarchy.json`。审计失败时任务失败且不发布半成品。该门禁只能证明运行缓存结构合法，不能替代源格式几何、装配、属性和 PMI 的正式样本矩阵。

需要规范化的输入不会采用“先预览源格式、后台转换后再切换 GLB”的双几何模式。原文件用于追溯和复转；任务在 `queued`、`processing` 或 `waiting_converter` 阶段不发布可浏览 manifest，转换和审计全部完成后才一次加载 `geometry.glb` 及 sidecar。原生 GLB、完整 glTF，以及 IFC、DXF、OpenUSD 的官方专用浏览管线不受此约束。

## M5 任务 API

- `GET /api/converters`：查询插件清单和当前可用性。
- `POST /api/projects/{projectId}/conversion-tasks`：提交任务。
- `GET /api/projects/{projectId}/conversion-tasks`：查询项目任务列表。
- `GET /api/projects/{projectId}/conversion-tasks/{taskId}`：查询任务。
- `POST /api/projects/{projectId}/conversion-tasks/{taskId}/cancel`：取消任务。

状态机为：

```text
queued -> running -> succeeded
   |         |  \-> failed
   |         \-> cancelling -> cancelled
   \-> waiting_converter -> cancelled
```

RVT、Parasolid X_T 与 JT 的支持边界以本文和运行时能力探测为准：自研/开源、本地离线，不以商业 SDK 或许可证服务器作为依赖或回退。格式声明、Provider 检测和样本验证在产品中分别展示，不能把格式名称当成完整解析能力。

## 当前纵向切片边界

- 已完成合同、插件目录、受控状态迁移、提交/列表/查询/取消 API、AbortSignal 取消、进度、GLB 几何审计与 sidecar 产物约束测试。
- 新任务目前保存在 API 进程内存中；持久化、重试、超时执行器、内容哈希缓存、日志对象和失败产物清理仍属于 M5 后续实现。

## 2026-08-31 本机验收记录

- OpenUSD 使用官方 `Sphere.usda`、`skinnedArm.usda`、`geom.usdc`、`simpleMesh.usdz` 和 Three.js 官方贴图 USDZ 验收；几何、动画、贴图结果与 SHA-256 见 [OpenUSD 原生查看管线](./openusd-asset-pipeline.md)。
- 本地已有许可与 SHA-256 来源清晰的 JT 10.3 小型零件、JT 9.5 多网格装配和 SolidWorks X_T 证据样本。JT 10.3 样本的 LOD0 已输出 8 个源顶点、12 个三角面和 6 个面组图元，包围盒为 `[0,0,0]`–`[100,80,60]`；JT 9.5 样本输出 44 个复用网格、64 个装配实例、23,999 顶点、47,962 三角面，实例采用 reader 的列主序 world transform，44 个网格均映射到 shape node。X_T 仅证明 V24.1 单体共轴旋转件子集；历史证据已汇总进[任务恢复总账](./active-task-recovery-ledger.md)。
- 本机未配置 `INDUSTRIAL_CAD_CONVERTER_COMMAND`；X_B 和超出内部子集的 X_T 仍等待。JT 只有命中内部 JT 9.5/10 小端 TriStrip/TopoMesh v1 且存在完整 LOD0 时才发布 GLB；没有受支持网格时仅保留层级、属性和检查证据并进入 `waiting_converter`。OpenUSD 不属于该外部 Provider 路径。
- 合成 Provider 仅用于验证“输入对象→隔离进程→GLB/sidecar→几何审计→对象存储”架构；它生成固定三角形，不能作为任何源格式解析能力的证据。

聚焦回归命令：

```powershell
pnpm --filter @bim-studio/api exec vitest run src/converterOutputAudit.test.ts src/industrialFormatWaitingAcceptance.test.ts src/externalConverterCatalog.test.ts src/conversionTasks.test.ts src/modelAssetRoutes.formatProbe.test.ts src/industrialFormatProbe.test.ts src/jtStructureProbe.test.ts src/xtStructureProbe.test.ts
```
