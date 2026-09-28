# 格式支持总表（内置/离线口径）

> 本文是各格式"当前真实能力"的权威速查；运行链细节与验收记录见
> [converter-plugin-and-format-support.md](./converter-plugin-and-format-support.md)、
> [builtin-profiles.md](./builtin-profiles.md) 与 `docs/reports/deep-core/` 各实施记录。
> 维护纪律：能力声明只能写到已验证证据；每个未知或近似结果必须有机器可读的
> loss/错误码记录；"任务 succeeded"不等于"模型 ready"。

**工业格式硬门槛（2026-09-16 权威计划）**：工业格式必须自研/开源、随包内置、本地离线。
依赖部署方自备文件、商业 SDK、商业转换器、源 CAD/BIM 软件或在线授权的路径
**不满足内置离线硬门槛，不计入合规生产能力**，只保留为本地研发验证或历史对照。

## 总览

| 格式 | 内置 profile | 最高质量档 | 合规生产能力 | 已验证真实样本 |
| --- | --- | --- | --- | --- |
| JT 8.0 / 8.1（结构读取） | 不属于 LOD0 几何 ready profile | `inspect`（容器与场景结构） | **仅结构检查，不发布可浏览几何** | 本地 8.x 样本 17 份；不作为可分发保留集 |
| JT 9.5 / 10.3（LOD0） | `builtin-jt-lod0-visual-complete` | `visual-complete`（已验证 LOD0 视觉档） | **是，限已验证样本 profile** | 各 1 份（Voyager，Apache-2.0） |
| Parasolid X_T | `builtin-x-t-revolved-subset` + 通用降级档 | `visual-complete`（已验证子集内） | **是**（限子集/通用档） | 子集 1 份 MIT + 通用 108 份回归语料 |
| Parasolid X_T 第三档（schema-aware） | 无内置（依赖部署方自备 catalog） | `visual-complete`（运行时） | **否——不满足内置离线硬门槛，不计入合规生产能力** | 本地研发验证 2 份 |
| Parasolid X_B | 阻断（等待内置 B-Rep 离散化） | `waiting_converter` | 否 | — |
| RVT | 已配置的 Revit Worker 产品转换链（非内置 Reader） | 原生 GLB / IFC | **现有产品链可用**（须安装并授权 Revit；不计入 builtin-only 验收） | 已有真实 RVT 的 GLB、层级与属性产物；本轮未复跑完整浏览器 E2E |
| IFC / glTF / GLB / FBX / DXF / STEP / OpenUSD | 浏览器/服务端既有管线 | — | 是（非工业格式计划范围） | 见 converter-plugin 文档 |

## JT（`packages/jt-reader`）

### JT 8.0/8.1：仅容器和场景结构检查

- 本地 17 份 JT 8.x 样本已验证容器、TOC、压缩段和 LSG 层级、实例、名称、材质数值与变换读取；这些样本没有可用于验证的网格段。来源不具备再分发依据，仅作本机兼容检查。
- **不属于 `builtin-jt-lod0-visual-complete` 几何 profile**；无受支持的 LOD0 网格时保留结构与诊断，不把“结构能读”标为模型几何 `ready`。8.x 网格、PMI、UV 与图像绑定均未验证。

### 已验证 LOD0 视觉能力（JT 9.5 与 10.3，小端；声明 profile：`builtin-jt-lod0-visual-complete`）

- 容器/TOC/LSG 解析，Deflate 与 XZ 段压缩，Int32CDP（JT 9）与 CDP2（JT 10）编码。
- TriStrip/TopoMesh LOD0 三角网格：拓扑重建、量化/无损坐标、法线、RGBA 顶点色、
  多纹理集 UV（源集合编号保真）、顶点旗标。
- 装配实例与列主序 world transform、材质路径、PMI（type 3）结构级清单
  （关联/模型视图/属性对/字符串表）。

### 明确保留的缺口（已知限制）

- 仅三角网格（TriStrip/TopoMesh）；B-Rep/精确曲面与隐藏线数据段不解析。
- PMI 仅结构清单，标注/尺寸/文本语义未解析。
- HSV 量化顶点色、附属字段（auxiliary fields）、big-endian TopoMesh、
  声明范围外的 TriStrip/TopoMesh 版本：显式拒绝，不猜测。
- 材质图像属性到纹理集的确定映射：无真实纹理样本证据，不声明。

### 稳定错误码（`JtErrorCode`，`packages/jt-reader/src/errors.ts`）

机器可读契约：消费方只依赖 `code`，禁止解析 `message` 措辞；code 一经发布冻结。

| code | 含义 |
| --- | --- |
| `format-invalid` | 缺省码：reader 自身不使用，保留给包外兼容 |
| `header-unrecognized` | 文件头无可识别 JT 版本 |
| `file-too-large` | 超过 `maxFileBytes` |
| `byte-order-unsupported` | 字节序标记非法，或 TopoMesh 仅支持小端 |
| `toc-inconsistent` | TOC/段长度/标识不一致 |
| `compression-unsupported` | 段压缩算法不受支持 |
| `decompress-failed` | XZ/Deflate 流解压失败 |
| `segment-payload-invalid` | 段载荷长度字段无效 |
| `lsg-segment-missing` | TOC 中找不到 LSG 段 |
| `read-bounds-exceeded` | 二进制读取越界 |
| `safe-integer-exceeded` | U64 超安全整数 |
| `limit-exceeded` | 数量/深度/工作量/解压输出超安全上限 |
| `count-mismatch` | 压缩包/数组长度与声明数量不一致 |
| `field-invalid` | 字段值非法（分量数、位宽、非有限数值等） |
| `hash-mismatch` | U32 内容哈希校验失败 |
| `binding-mismatch` | 内外层属性绑定掩码不一致 |
| `quantization-invalid` | 量化参数非法 |
| `quantization-code-out-of-range` | 量化码超值域（典型损坏） |
| `topology-invalid` | 拓扑重建结构约束不满足 |
| `index-out-of-range` | 三角索引越界 |
| `polygon-degenerate` | 退化多边形（<3 顶点） |
| `attribute-encoding-unsupported` | HSV 颜色 / 附属字段不受支持 |
| `shape-version-unsupported` | TriStrip/TopoMesh 形态或版本不受支持 |
| `codec-unsupported` | Int32CDP/CDP2 CODEC 不受支持 |
| `graph-cycle` | 场景图循环 |
| `node-reference-missing` | 引用不存在的节点 |
| `pmi-layout-invalid` | PMI 段布局解析失败 |

### 稳定损失/诊断码（`JtLossCode`，`packages/jt-reader/src/types.ts`）

`JtDocument.losses[]` 每条含 `code`（机读）、`kind`（`loss`=解码丢弃/近似、
`known-limitation`=解析器能力边界、`source-fact`=已验证的源文件事实）、
`scope`（`document` / `segment:<id>` / `pmi:<id>`）、`detail`（人读）与可选
`errorCode`（底层 `JtErrorCode`）。

| code | kind | 触发条件 |
| --- | --- | --- |
| `tessellation-only` | known-limitation | 有解码网格时始终声明：仅三角网格 |
| `no-mesh-decoded` | loss | 候选网格段存在但全部失败 |
| `mesh-segment-absent` | source-fact | 文件不含候选网格段 |
| `uv-binding-absent` | source-fact | 全部网格无 UV/纹理集绑定 |
| `mesh-segment-decode-failed` | loss | 单个网格段失败（`errorCode` 携带原因） |
| `lsg-element-uninterpreted` | loss | 未解释 LSG 元素按长度跳过 |
| `pmi-segment-absent` | source-fact | 无 PMI 段 |
| `pmi-structure-only` | known-limitation | PMI 仅结构清单 |
| `pmi-segment-parse-failed` | loss | PMI 段解析失败（`errorCode` 携带原因） |
| `pmi-segment-structure-unknown` | loss | PMI 段无 Manager 元素 |

`warnings: string[]` 保留为人读汇总，与 `losses[].detail` 同源文本，不承载机读语义。

## Parasolid X_T（三档）

1. **子集档** `builtin-x-t-revolved-subset`：V24.1 单体共轴旋转件
   （`SCH_2401231_20000_1300`，plane/cylinder/cone/torus），内置离线，合规生产。
2. **通用降级档**（`packages/xt-reader`）：平面/圆柱/圆锥/球面族按证据发布，
   108 份真实样本解析回归；trim、名称/颜色/装配如实进 losses；内置离线，合规生产。
3. **schema-aware 几何发布档**：依赖部署方自备 Parasolid 官方 schema catalog
   （`PARASOLID_SCHEMA_CATALOG`）。**该档不满足内置离线硬门槛，不计入合规生产能力**，
   仅作部署方自担的增强路径与本地研发验证；无 catalog 时运行链逐字节维持 ①② 语义。

parasolid-kit v0.2.0（MIT/Apache-2.0）另含五个精确 key 的内置 profile（`verified_subset`，
零 user fields），当前**仅本地研发验证、未获匹配真实样本端到端验收**，
逐 key 状态见 [builtin-profiles.md](./builtin-profiles.md)。

## RVT

**现有产品转换链可用**：配置了 Windows Revit Worker、安装并授权兼容 Revit 后，可将 RVT 转为原生 GLB（包含已验证样本的层级与属性）或 IFC，并经现有资产发布和 Web 查看链消费。已有真实 RVT 原生 GLB 与 sidecar 产物；本轮未重新验证两种模式的完整浏览器 E2E。需区分：**无需 Revit 的随包内置 Reader 尚未验收**，因此 Worker 路径不计入 RVT builtin-only 验收，而非“RVT 不能用”。
