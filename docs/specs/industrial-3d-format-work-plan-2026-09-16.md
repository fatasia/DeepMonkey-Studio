# 工业三维格式接入工作计划

日期：2026-09-16。状态：**工作计划；实现与真实语料验收待执行**。

目标是让 Deep Monkey Studio 在离线环境中接入七个高价值方向：JT、Parasolid `.x_t`、RVT、E57/LAS/LAZ/COPC 点云、3D Tiles、Rhino 3DM、SolidWorks SLDPRT/SLDASM。源文件保留，运行时使用可审计的规范化资产和可追溯的质量报告。

## 1. 先回答“有没有依赖”

**不是零依赖。** 计划不依赖云转换、在线授权、Revit/NX/SolidWorks/Rhino 源软件或商业 SDK；解析器、压缩库、几何库和运行时仍然存在，全部固定版本、随桌面/服务安装包交付，默认断网运行。

| 方向 | 不作为运行前置 | 允许随包交付的本地依赖 | 当前事实与限制 |
| --- | --- | --- | --- |
| JT | NX、Teamcenter、JT Open 商业 SDK、在线服务 | 现有 TypeScript Reader、`xz-decompress`；后续自研解码器 | 已有 9.5/10 小端 TriStrip/TopoMesh 子集；完整版本/编码/精确 B-Rep 仍需扩展 |
| X_T | Parasolid 商业内核、CAD 软件、许可证服务器 | 自研文本解析器；评估 `parasolid-kit` 的 parser/core 模块（许可逐文件审计）和可选 OCCT/OCP | 当前产品仅有严格 V24.1 旋转件子集；`parasolid-kit` 也只覆盖声明的 profile，不能当通用解析器 |
| RVT | Revit、APS 云、ODA/HOOPS | 评估 `rvt-rs`（Apache-2.0）并补自研 Rust/WASM/原生解码 | 开源路线可读容器和部分构件；完整项目几何、族、机电与跨版本仍未解决。现有 Revit Worker 继续保留，但它有 Revit 依赖 |
| E57/LAS/LAZ/COPC | 在线点云平台、云对象存储 | libE57Format、PDAL、LAZ 解码器和本地空间索引 | 依赖可打包；投影数据库、坐标和大文件驻留需要单独随包与运行时预算 |
| 3D Tiles | Cesium Ion、Google Tiles API、在线 URL | 本地 `3d-tiles-renderer`/Three.js 适配器、压缩解码器 | 小型本地 tileset 可离线；远程 URI、隐式分块、所有 1.1 扩展需逐项验证 |
| Rhino 3DM | Rhino、Grasshopper、插件运行时 | openNURBS/rhino3dm；必要时自有曲面离散桥 | 已保存显示网格较容易读取；无缓存 NURBS、插件对象和 Grasshopper 语义不能自动获得 |
| SolidWorks | SolidWorks、商用转换器、在线授权 | 自研/审计后的 clean-room Reader，候选 `cadmpeg`（Apache-2.0） | 候选当前主要是 L1 容器级；完整 SLDPRT/SLDASM 配置、载荷和装配仍属高风险研发 |

这里的“随包依赖”依然是依赖，只是它不要求用户另装软件，也不需要网络。若要求连开源库都不能使用，则七个方向都需要自研解析、压缩和几何内核，时间和风险会显著上升。

本计划不设置商业 SDK、商业转换器或许可证服务器回退。某个 profile 暂时无法由自研/开源链路可靠解析时，保持 `inspect`/`preview` 或明确阻断，不能借外部商业组件补齐结果后计入验收。

### 1.1 运行时是否需要其他语言环境

本方案的**用户运行时不需要单独安装其他语言环境**：

- Web/API 继续使用项目已有的 TypeScript/Node.js；浏览器侧不要求用户安装 Python、Rust 或 C++。
- 桌面/服务端分发预编译的 Worker（优先一个受限宿主进程加格式模块）；Rust/C++/Python 只存在于 CI 或开发机的构建阶段。
- X_T 的 Python/OCP 组合只能用于 S0 技术验证，不能进入生产安装包。生产桥必须编译成原生 Worker；如果无法在无 Python 机器上完成同等验证，该 profile 不发布。
- E57/PDAL、openNURBS、OCCT 等库按固定版本静态链接或随 Worker 目录交付，用户不依赖系统 PATH、pip、conda、Visual C++ Redistributable 或 CAD 安装目录。
- 可选的 WASM Reader 也必须把 `.wasm` 与依赖一起放入安装包；WASM 不是联网下载的替代名称。

因此是“**应用带自己的运行库**”，不是“没有依赖”。构建工具链可以有多种语言，终端用户只看到现有应用、Worker 和按需格式包。

### 1.2 体量控制与冻结预算

不把所有格式库打进核心安装包。初始体量预算用于 S0 实测和冻结，**不是当前实测结果或承诺**：

| 包 | 包含 | 初始目标 |
| --- | --- | --- |
| `studio-core` | 现有 Web/API、JT/3DM/Tiles 的轻量运行层、通用压缩和 GLB 优化 | 保持当前核心包级别，不因新增格式引入大型 CAD 内核 |
| `cad-geometry-pack` | X_T 解析、受支持 OCCT 几何映射与离散 | 目标控制在 200 MB 内；若超出则拆 profile/按需安装 |
| `bim-rvt-pack` | RVT 容器、Schema 和已验证构件解码 Worker | 目标控制在 100 MB 内；复杂解码数据按版本分包 |
| `pointcloud-pack` | E57/LAS/LAZ/COPC Reader、索引和点云运行时 | 目标控制在 150 MB 内；大样本不预置在安装包 |
| `solidworks-pack` | SLDPRT/SLDASM 研究/生产 profile | S0 前不承诺体量；未过可复现构建和兼容门槛时不随包发布 |

如果实测发现 OCCT/PDAL 或 schema 数据超过预算，优先拆成可选离线包，不能通过删功能、压缩未知数据或静默联网下载来“变轻”。安装器显示每个格式包的大小、版本和校验值，核心安装与格式包升级相互独立。

首期的“轻量”指标同时看安装体量、冷启动、峰值 RSS、临时磁盘和首次可交互时间；单看压缩后的 GLB 大小不够。S0 必须在干净断网 Windows 机器上实测这些指标，再冻结最终预算。

## 2. 统一产品边界

### 2.1 五个必须分别验收的维度

1. **几何**：形状、孔洞、曲面离散、法线、单位和镜像方向正确。
2. **结构**：装配、楼层、构件、实例、块、扫描站、瓦片层级和外部引用正确。
3. **属性**：源 ID、名称、类别、类型、材质、单位、业务属性、PMI/点属性可追溯。
4. **交互**：选择、隐藏、隔离、剖切、测量、定位、数据绑定、刷新恢复正确。
5. **交付**：任务可取消、可恢复、可复转；旧版本不被失败任务覆盖；可在断网环境读取。

只读出文件头、缩略图或一个包围盒，不能算几何完成。每个未知或近似结果都进入机器可读的 loss/diagnostic 列表。

### 2.2 质量档

| 档位 | 用途 | 是否允许正式模型 `ready` |
| --- | --- | --- |
| `inspect` | 文件、版本、容器、依赖和元数据检查 | 否 |
| `preview` | 部分、近似或诊断几何 | 否，只能私有预览 |
| `visual-complete` | 声明范围内构件、坐标、几何和身份完整 | 是，需通过该 profile 的全部必需项 |
| `engineering-verified` | 增加精确 B-Rep、严格误差、PMI/工程关系 | 按 profile 单独开放 |

任务 `succeeded` 不等于模型 `ready`。目标质量、源 profile、缺失项、近似项和验证证据必须写入结果。

## 3. 系统目标架构

```text
模型入口 → SourceBundle/依赖闭包 → 统一 ConversionTask
        → 本地隔离 Worker → 格式 Reader → 中立资产 IR
        → 坐标/身份/几何/属性质量检查 → 优化与分块
        → GLB/点云块/Tiles 包 + sidecar → 原子发布
        → Web 场景、对象树、属性、测量、绑定、Native 发布
```

复用现有 `ConversionQueue`、`ConversionTaskService`、`ConverterPluginManifest`、`ModelManifest`、`modelFormatCatalog`、`converterOutputAudit`、PostgreSQL + MinIO 和坐标帧机制。上传队列与任务 API 必须归一到同一个任务服务，不能各自运行一套 Provider。

拟注册内置 Provider：`bim.jt-builtin`、`bim.xt-builtin`、`bim.rvt-builtin`、`bim.pointcloud-builtin`、`bim.3dtiles-builtin`、`bim.3dm-builtin`、`bim.solidworks-builtin`。Provider 的可用性由实际打包组件、版本和 profile 探测决定，不能根据扩展名直接标记可用。

四类输出：

- 网格格式：`geometry.glb`、`hierarchy.json`、`properties.json`、可选 `pmi.json` 和 source map。
- 点云格式：`PointCloudManifest v1`、分块点属性、空间索引、扫描姿态和精度报告；不伪装成三角网格。
- 3D Tiles：本地化 tileset、所有依赖哈希、tile/subtree 图、feature 元数据和运行时调度信息。
- 所有格式：`ImportRecipe`、`SourceIdentity`、`CoordinateFrame`、`ConversionQualityReport` 和原始源文件哈希。

每个派生产物写入独立 attempt 目录，完成哈希和质量审计后才在数据库事务中移动活动版本指针。失败、取消和复转保留既有 ready 版本。

## 4. 七个方向的工作包

### WP-JT：JT

复用 `packages/jt-reader` 和现有 GLB 转换器。第一步固定 JT 9.5/10.x 的真实样本矩阵，补齐压缩编码、量化、法线、UV、颜色、材质继承、多 LOD 和多文件引用。第二步建立装配实例共享网格、深层路径、可见性、镜像和外观覆盖的 source map。第三步再评估精确 B-Rep、PMI 和无显示网格载荷。

完成条件：每个开放版本格有独立正例和失败反例；LOD0/源显示精度、实例数量、变换、材质和对象 ID 通过固定参考；缺失引用精确到装配路径。

### WP-X_T：Parasolid `.x_t`

当前 V24.1 旋转件解析器只保留为已验证 profile。围绕 `parasolid-kit` 的 parser/core 模块新增实验适配器，拆成文本与 Schema、实体图、曲线曲面、OCCT 映射、离散与 source map 五层。先完成平面、圆柱、圆锥、球、圆环、修剪面和多实体，再进入 NURBS、偏置、交线与复杂圆角。

OCCT 只负责受支持几何的构造、验证和离散；它不会自动变成通用 X_T 导入器。任何未知 Schema、无效拓扑、周期/有理 NURBS 限制和容差修复都必须拒绝或降为诊断档。

完成条件：拓扑引用闭包、面方向、孔洞、单位、面积/体积（有可信参考时）以及 GLB 面来源通过；每次修复保存前后差异。X_B 不因共用库而自动加入公开入口。

### WP-RVT：RVT

先将 `rvt-rs` 作为容器/Schema/元素索引实验底座，补版本化分区解码和稳定身份；按墙、楼板、柱梁、门窗、幕墙、屋顶楼梯、家具设备、管风桥架、链接/阶段/设计选项顺序推进。几何来源严格区分持久几何、参数重建、诊断包围盒和缺失。

RVT 首批必须有至少两栋独立建筑，包含建筑、结构、机电和链接；一栋楼的多个版本不能证明通用兼容。现有 Revit Worker 只保留为历史对照，不属于本计划运行链路，也不能计入 builtin-only 证据；产品能力必须由自研/开源 Reader 独立完成。

完成条件：构件身份、世界坐标、开洞、宿主、类型、参数、材质和楼层关系逐项核对；跨版本与未知字段保留 unknown，不用默认值填充。

### WP-PC：E57/LAS/LAZ/COPC

采用本地 libE57Format/PDAL 组合。增加点云数据合同，保存点数、有效点、属性、量化 scale/offset、CRS/单位、扫描姿态、bounds、空间节点、块哈希和 LOD 采样规则。Web 先实现预算调度、颜色/强度/分类切换、裁剪和点拾取；Native 单独实现 point primitive 和驻留回收。

完成条件：四种输入各有多站/大坐标/缺 CRS/损坏块样本；无损主集点数与属性一致；抽稀、噪声和非法点有明确计数；BIM 配准矩阵可保存、恢复和审计。

### WP-TILE：3D Tiles

按 OGC 3D Tiles 1.1 建立本地 tileset 能力表，先覆盖 mesh/glTF 内容，再补 b3dm/i3dm/pnts、implicit tiling、subtree、multiple contents 和结构化元数据。使用本地 `3d-tiles-renderer` 做 Web 验证，禁用在线 Cesium/Google provider。

完成条件：依赖闭包无外部 URI；transform、box/sphere/region、ADD/REPLACE、geometricError、feature ID 和元数据在固定相机路径下正确；首次可交互、P95 帧时、请求/字节和驻留量可测。小型 tileset 可烘焙为静态资产，但不能宣称 Native 流式能力。

### WP-3DM：Rhino 3DM

采用 openNURBS/rhino3dm，优先读取保存的 render mesh、Mesh、Brep、Extrusion、图层、块实例、材质、对象 UUID 和用户字符串。无保存网格的 NURBS 进入独立曲面离散桥；SubD、插件对象、Grasshopper 运算不自动执行。

完成条件：网格缓存与无缓存文件分开统计；块嵌套、镜像、非均匀缩放、单位、图层可见性和 UUID 稳定；曲面孔洞、周期面和材质/贴图通过 profile 验证。

### WP-SW：SolidWorks SLDPRT/SLDASM

先做候选 Reader 与 clean-room 法律审计，再实现保存状态、配置、零件/装配 occurrence、外部引用、抑制状态、显示缓存、面/体外观和属性。`cadmpeg` 当前可作为研究候选，容器级读取不能被标记为几何完成。SLDPRT 与 SLDASM 分开验收；内部 Parasolid 载荷另有解析边界。

完成条件：至少三来源的 20 个零件和 8 套完整装配；核对配置、原型/实例数、变换、抑制、缺引用、关键尺寸、材质和身份。没有证据的版本保持 unverified；不执行宏、配合求解或源文件写回。

## 5. 执行顺序

| 阶段 | 任务 | 交付门槛 |
| --- | --- | --- |
| S0 | 样本、许可、依赖、离线构建和 CLI 纵向实验 | 七方向各有输入、依赖清单、失败分类和体积/RSS记录 |
| S1 | 统一任务、SourceBundle、质量合同、持久化、租约、幂等和原子发布 | 重启、取消、并发、对象失败和旧版本保留测试通过 |
| S2 | JT 实用覆盖 + 3DM 保存网格切片 | 真实装配/块/材质/身份和两端查看通过 |
| S3 | 点云 + 3D Tiles 空间运行时 | 本地离线、分块调度、配准/坐标、资源回收通过 |
| S4 | X_T 常见实体与 OCCT 离散桥 | 解析曲面、拓扑、孔洞、单位和误差报告通过 |
| S5 | RVT 基础建筑 + SolidWorks 可行性/零件装配试点 | 多来源构件/配置证据；不把诊断代理当 ready |
| S6 | 高保真扩大与混合场景 | 版本矩阵、Native/Web、发布、断网和回滚全通过 |

顺序不是承诺所有阶段连续完成：S2/S3 可形成近期产品增量，S4/S5 根据 S0 样本证据重估。RVT 与 SolidWorks 的完整覆盖属于持续研发，不能给出未经实测的最终日期。

## 6. 共用任务清单

| ID | 任务 | 主要产物 |
| --- | --- | --- |
| PLAN-01 | 固定七方向样本、授权、哈希、预期对象和参考导出 | 第一批语料与缺口已锁定，见 [PLAN-01/02 报告](./industrial-format-plan01-02-lock-2026-09-16.md)；生产矩阵仍待补齐 |
| PLAN-02 | 固定 OSS 版本、许可证、构建链和离线安装包 | 第一批版本/许可/工件 hash 已锁定，见同上报告；离线试构建和安装体量仍待执行 |
| PLAN-03 | 新增 SourceBundle/ImportRecipe/CoordinateFrame/QualityReport 合同 | contracts 包、迁移与兼容测试 |
| PLAN-04 | 统一上传队列与 ConversionTaskService | API/上传/MCP/SDK 同一任务 ID |
| PLAN-05 | Worker 隔离、资源限制、取消、租约、重试和恢复 | 故障注入与重启日志 |
| PLAN-06 | 四类产物审计与不可变发布 | GLB/点云/Tiles 结构、哈希和质量门禁 |
| PLAN-07 | 实现 WP-JT、WP-X_T、WP-RVT、WP-PC、WP-TILE、WP-3DM、WP-SW | 每方向独立 profile 与证据报告 |
| PLAN-08 | 统一优化、LOD、空间分块、source map、BVH/Native 派生 | 源/主/LOD 差异报告 |
| PLAN-09 | Web/Native 接线和混合场景 | 选择、测量、绑定、发布和恢复 E2E |
| PLAN-10 | 断网安装、完整安全矩阵、性能和视觉门禁 | 干净机、故障、性能、截图和十维评分 |
| PLAN-11 | 更新格式目录、README、第三方说明、CHANGELOG 和恢复总账 | 实际支持范围与回滚指引 |

## 7. 验收规则

真实保留集按“版本 × 生产软件 × 几何特征 × 规模 × 依赖结构”分层，至少 30% 不参与调试。每个正式开放 profile 至少需要独立来源正例、失败反例、确定性输出、源映射、错误报告和模糊测试；合成样本只能证明单个边界。

几何门槛由参考精度冻结后执行：单位/坐标/镜像一致，曲面弦差和法线预算按源精度分配，RVT 局部孔洞/薄壁单独检查；面积/体积只在闭合实体和可信参考存在时使用。优化和 LOD 的误差不能重复占用同一预算。

全链路必须覆盖：上传、依赖补齐、检查、转换、审计、对象存储、刷新恢复、选择/属性/测量/绑定、发布、公开读取、断网读取、取消、超时、Worker 崩溃、数据库/对象存储失败和失败复转。

UI/3D 实现使用 `design-taste-digitaltwin`：令牌来自 `apps/web/src/styles/base.css`，工业状态采用文字、图标、颜色三重编码，场景使用 ACES/PBR/光照/雾与克制的 Bloom；执行至少两轮浏览器截图和十维评分，任何维度低于 9/10 返工。格式真值比较使用中性环境，不能用视觉美化掩盖丢件。

## 8. 当前状态、风险和停止条件

- 已有 JT 子集、X_T 旋转件子集、RVT Worker 和通用转换任务/产物审计；它们不代表七方向完整支持。
- 当前没有把新库安装到产品，也没有完成七方向真实转换、Native 接线或离线干净机验收。
- 最大风险是 X_T/RVT/SolidWorks 私有结构、版本漂移、复杂曲面和装配保存状态；点云/3D Tiles 的主要风险是空间坐标、驻留调度和大文件资源预算。
- 任一候选库的开放源码授权、构建可复现性、独立样本或安全边界不满足时，停止该 profile 的生产声明，保留 inspect/preview，并继续自研或更换可审计的开源实现；不转商业 SDK/商业转换器。
- 连续两个迭代没有增加独立样本覆盖时，缩小范围并记录阻塞原因；不把文件头、包围盒数量或合成三角形当作进展。

## 9. 参考附录

- [JT/X_T/RVT 技术接入细案](./jt-xt-rvt-offline-integration-plan-2026-09-16.md)
- [点云、3D Tiles、3DM、SolidWorks 细案](./additional-four-formats-integration-plan-2026-09-16.md)
- [格式价值排序](./high-value-3d-formats-2026-09-16.md)
- [现有转换插件合同](../converter-plugin-and-format-support.md)
- [OGC 3D Tiles](https://www.ogc.org/standards/3dtiles/)
- [PDAL E57/COPC](https://pdal.io/en/latest/stages/readers.e57.html)、[COPC](https://copc.io/)
- [openNURBS/rhino3dm](https://www.rhino3d.com/features/developer/opennurbs/)
- [parasolid-kit](https://github.com/monozukuri-ai/parasolid-kit)、[rvt-rs](https://github.com/DrunkOnJava/rvt-rs)、[cadmpeg](https://github.com/cadmpeg/cadmpeg)

本文件是七方向的唯一工作计划入口；详细方案是附录，实际生产支持仍以每个 profile 的机器可读证据和格式目录为准。
