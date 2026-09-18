# Deep Engine P2 → GLM 完整交接（2026-09-14）

> **已撤销，不执行。** 用户纠正为 P3 交给 GLM；本文件仅保留误建记录，不代表任务授权或当前分工。有效交接见 [P3 GLM 交接](deep-engine-p3-glm-handoff-2026-09-14.md)。P2 继续由 Codex 主线负责，下文指令全部失效。

这份文档把 P2 完整交给 GLM：轻量离线烘焙、Nanite Lite、Deep Lights、Deep GI Lite（Lumen Lite）。目标是形成可被 Browser 与 Windows Native 共同消费的正式能力，不再新增孤立 Lab。

## 给 GLM 的启动指令

> 接手 `docs/specs/deep-engine-p2-glm-handoff-2026-09-14.md` 中的全部 P2。先读取 `AGENTS.md`、本交接、`deep-engine-webgpu-remaining-plan-2026-09-14.md` 和当前 `git status`/最近提交；以工作树为权威，复用已有 Meshlet、LOD、Hi-Z、Residency、Forward+、Shared Shadow Atlas 和 Probe Clipmap 组件。按 P2-A → P2-N → P2-L → P2-G 的依赖顺序推进，合同冻结后允许 N/L 并行；每个切片必须包含实现、失败/取消/预算测试、Browser 真 GPU 证据、Runtime Package 接线和交接回填。不得把类型、单测、固定 Probe 或计划文档写成产品完成。不要改 Studio 的 P0 切换/作者状态，不要修改固定 `admin/admin`、数据库/.env、许可证和存储拓扑，不要 push；新增依赖或公共合同破坏性升级先向用户申请。

## 1. 所有权与边界

GLM 对下列四项负全责，包括设计、实现、测试、真实 GPU 证据、文档和最终缺口清零：

| Epic | 结果 | 估算 |
|---|---|---:|
| P2-A | 可重复、可增量、可跨 Browser/Native 消费的离线烘焙产物 | 6–9 人日 |
| P2-N | 正式渲染路径中的 Nanite Lite | 10–15 人日 |
| P2-L | 大量局部光可控且可降级的 Deep Lights | 8–12 人日 |
| P2-G | 不依赖硬件 RT 的 Deep GI Lite / Lumen Lite | 11–19 人日 |

总投入仍按 **35–55 人日** 管理。3 条熟悉图形代码的工程线可压缩到 **5–8 周**；单个 GLM 会话按依赖串行时不可使用并行日历冒充工期。

不属于本交接：Studio 后端切换、同一作者状态、设置入口、Native Viewer 产品 UI、Deep2D/GUI/Chart、硬件光追。P2 可以补充它们需要的合同和诊断字段，但不得接管或重写这些产品层。

明确排除：UE 全套 Nanite 软件光栅化、Virtual Shadow Maps、Lumen Surface Cache、完整 UV Lightmap/Enlighten 工作流、依赖硬件 RT 的主路径、非 Windows 平台适配、长尾资产解码器。

## 2. 当前可复用基线

下面是“已有组件”，不是“Epic 已完成”。GLM 开工前必须逐项重新跑测试并核对公开导出。

| 领域 | 已有实现 | 仍未证明 |
|---|---|---|
| Bake | `assetBakePlan.ts`、`assetBakeResidency.ts` 已生成确定性 Meshlet、展开索引、材质变体、纹理清单和 cache key；Runtime Package 有 prewarm plan/executor/WebGPU adapter | 没有正式离线 CLI/文件产物；没有层级误差、量化、离线 KTX2、增量依赖图、跨语言完整消费 |
| Nanite Lite | Meshlet builder/bounds/cone/cull/indirect、GPU LOD、Hi-Z pyramid/occlusion/history、packet residency/streaming 均已有独立实现与 Lab 探针 | 尚未在正式 `PbrRenderer` 组成一条层级选择→剔除→indirect→驻留路径；容量扩容、提交后退役、真实大模型时序未闭环 |
| Deep Lights | Forward+ cluster grid/packing/compute/PBR、重要性预算、世界灯光合同、共享 shadow atlas 计划与 GPU 资源、局部 spot shadow runtime 已存在 | 局部光阴影尚未完整进入主 renderer/shader；point 六面、固定阴影采样预算、稳定降级、资源回落和大灯光场景未闭环 |
| GI Lite | Probe clipmap 计划、资源、采样 WGSL、更新调度、capture executor、WebGPU capture adapter、runtime/controller 与 Lab probe 已存在 | 尚未接入正式场景辐射度捕获、遮挡、屏幕空间补偿、动态 dirty 区域和主 `PbrRenderer`；画质/时序/预算没有产品证据 |

主要代码入口：

- Bake/Package：`packages/deep-engine/src/assetBakePlan.ts`、`assetBakeResidency.ts`、`runtimePackage/`、`webgpu/runtimePackagePrewarmAdapter.ts`
- Geometry：`packages/deep-engine/src/geometry/meshlet*`、`webgpu/meshlet*`、`webgpu/gpuLod*`、`webgpu/hiZ*`
- Residency：`packages/deep-engine/src/streaming/`、`webgpu/packetResidency*`、`pbrResidencyStream.ts`、`sceneChunkResidency.ts`
- Lights：`packages/deep-engine/src/lighting/`、`shadows/sharedShadowAtlas.ts`、`webgpu/sharedShadowAtlasResources.ts`、`localSpotShadowRuntime.ts`
- GI：`packages/deep-engine/src/lighting/probeClipmap*`、`webgpu/probeClipmap*`、`webgpu/webgpuProbeCapture*`
- 正式 Browser 集成点：`packages/deep-engine/src/webgpu/pbrRenderer.ts`、`pbrFrameGraph.ts`、`pbrShader.ts`、`pipelines.ts`
- Native 合同/消费：`packages/deep-engine-native/src/runtime_package/`、`lod_contract.rs`、`gpu_lod*`、`gpu_culling*`、`renderer/`

## 3. 执行顺序与并行方式

```text
P2-A 合同/产物冻结 ──┬── P2-N Nanite Lite ──┐
                     └── P2-L Deep Lights ───┼── P2-G GI Lite ── P2 总验收
P0 Runtime/诊断合同 ──────────────────────────┘
```

1. 先完成 P2-A1～A4，冻结 bake artifact 和 Runtime Package 扩展。
2. 合同冻结后，P2-N 与 P2-L 可分文件并行；两者不得各建一套预算或资源生命周期。
3. P2-G 可先做纯合同/调度，但正式接入须等待 P2-L 的灯光 dirty 事件和 P2-N 的场景/驻留 dirty 事件稳定。
4. 每天合流一次公共合同；发现 P0 接口缺口时新增窄适配器，不改写 P0 作者状态和 Studio 切换。

建议文件所有权：A 线只写 bake/runtime-package/scripts；N 线写 geometry/webgpu meshlet+LOD+Hi-Z+residency；L 线写 lighting/shadows；G 线写 probeClipmap/capture。`pbrRenderer.ts`、`pbrFrameGraph.ts`、Runtime Package schema 和根导出由主线单点合流。

## 4. P2-A：轻量离线烘焙

| ID | 任务与产物 | 验收 |
|---|---|---|
| A1 | 冻结 `deep-engine.bake-artifact` v2：源 package hash、recipe/tool/build identity、质量档、资源 DAG、字节预算、能力要求和降级信息 | 严格 schema、唯一 JSON、大小/深度/数量限制；TS/Rust golden 一致；未知版本拒绝 |
| A2 | 把现有 Meshlet 产物扩为层级 DAG：父子、包围球/AABB、normal cone、几何误差、screen-space error、最粗可绘制 fallback | 同输入/recipe 位级确定；退化/空/非有限/超限几何结构化失败 |
| A3 | 生成每几何 LOD/meshlet residency page、chunk 依赖、visible/prefetch 初始清单和估算 GPU 字节 | Runtime 不扫描原始几何即可规划；任一细节缺失仍能选最粗层 |
| A4 | 增量构建与 CAS：geometry revision、recipe、quality、压缩配置、材质/纹理依赖进入 cache key；原子写入与取消 | 同输入命中；任一输入变化只重建受影响节点；中断不发布半成品 |
| A5 | 顶点/法线/UV/索引量化，记录格式与最大误差；超阈值保留原精度 | 解码后位置/法线/UV 误差过冻结阈值；镜像/非均匀缩放/TBN 不回归 |
| A6 | 离线 KTX2/Basis 压缩与 mip 链；保留 sRGB/linear、normal/MR/AO 语义和 alpha | BC/ETC2/ASTC 能力选择与未压缩 fallback；通道和颜色空间 golden 通过 |
| A7 | 材质变体、ShaderPackage/pipeline prewarm manifest；只保存可序列化描述，不保存 GPU handle | Browser/Native 对同一 manifest 得到同一 key；坏 shader 保留 last-known-good |
| A8 | 提供 Node CLI：输入已验证 GLB/Runtime Package，输出 artifact、manifest、统计 JSON；支持 `--quality`、`--out`、`--signal`/取消等价机制 | 无网络、无路径泄露、非零退出码稳定；帮助、坏输入、覆盖保护和 Unicode 路径测试 |
| A9 | Browser 与 Native 消费 v2；旧 v1 有显式迁移或拒绝，不允许静默忽略高级字段 | 相同 artifact 跨语言 golden；首帧不运行离线工作；预算与降级进入诊断 |

新依赖规则：先核对现有 `meshoptimizer 1.0.1`、KTX2/Basis 运行时和许可证。若离线编码必须引入二进制/库，GLM 先给出版本、许可证、Windows 可复现构建、包体和替代方案，获得用户批准后再改 lockfile/第三方声明。

## 5. P2-N：Nanite Lite

| ID | 任务与产物 | 验收 |
|---|---|---|
| N1 | 层级 Meshlet 选择器：投影误差、质量档、迟滞、相机跳变和每帧选择预算 | 静止稳定；运动无往返抖动；teleport/resize 清历史；超预算回最粗层 |
| N2 | 把 GPU frustum、previous-frame Hi-Z、normal cone/affine bounds 组成正式剔除链 | false occlusion 为 0；相机/物体运动、透明、剖切、镜像/非均匀缩放均有保守 fallback |
| N3 | `MeshletIndirectExecutor` 接入主 frame graph；支持容量增长、上限、overflow 诊断和直接/现有 LOD 回退 | 不截断绘制；扩容候选后台准备、帧边界发布；旧 buffer 在 submission 后退役 |
| N4 | 与 packet residency/scene chunk/working set 合流，按所选层请求 geometry page 和纹理 mip | 显存/上传预算有界；取消/迟到/驱逐保持 CPU/GPU 状态一致；device epoch 不复用旧资源 |
| N5 | 选择、测量、拾取、阴影、动画蒙皮/morph 的策略 | 不支持变形的资源显式回现有 LOD；作者对象 identity 不因 meshlet 变化 |
| N6 | 正式 `PbrRenderer` feature/quality profile 和诊断：active path、fallback reason、visible/submitted meshlets、triangles、bytes、overflow | `auto/performance/balanced/quality` 唯一入口；默认不暴露底层开关墙 |
| N7 | 真实负载：开放厂区、强遮挡机房、动态输送线，10k/100k 实例或等价三角规模 | 小场景 GPU P95 不回退 >10%；大场景同画质相对 P0 LOD fallback 目标改善 ≥20%；峰值显存不越预算；运动视频无明显 popping |

N7 的百分比是首轮工程门槛，不是营销结论。若硬件/场景不满足，报告原始数据、置信范围和根因，不降低画质或隐藏失败。

## 6. P2-L：Deep Lights

| ID | 任务与产物 | 验收 |
|---|---|---|
| L1 | 冻结局部光 ABI 与质量档：directional、point、spot；单位、范围、锥角、阴影资格和重要性 | CPU/WGSL packing 一致；非有限/负值/超限拒绝；同灯跨帧稳定排序 |
| L2 | 把 Forward+ cluster compute 与 PBR 主 shader 接成正式路径 | cluster overflow 不越界；透明/双面/法线贴图/IBL/雾组合正确；无重复色彩编码 |
| L3 | Shared Shadow Atlas 主路径：spot 单视图、point 六面，depth32float tile/guard/PCF；候选原子替换 | atlas 预算、light/view 上限和拒绝原因可见；失败保留旧 atlas；资源可退役 |
| L4 | 固定每像素灯光/阴影采样预算；超量按重要性降级为无阴影或不进入 cluster | 相机微动不闪烁；新增弱灯不挤掉强灯；降级是机器可读状态 |
| L5 | shadow dirty：灯、caster、shader、atlas revision 分类；静止帧不重绘 | 静止 120 帧 shadow update 为 0；局部变化只更新受影响 tile/face |
| L6 | 设备能力与资源降级：无 timestamp、低 limits、OOM、device loss | 回到 CSM+无阴影局部光或基础灯光，保留最后正确帧；原因进入统一诊断 |
| L7 | 真实灯光矩阵：8/32/128/256 灯，静止/运动/遮挡三场景 | 固定分辨率、构建/资产 hash、adapter/backend、P50/P95/P99、atlas bytes 和降级计数可重跑 |

Deep Lights 的默认无 RT。不要把随机阴影、路径追踪或可选硬件 RT 作为完成前置。

## 7. P2-G：Deep GI Lite / Lumen Lite

| ID | 任务与产物 | 验收 |
|---|---|---|
| G1 | 冻结 irradiance probe clipmap 合同：级数、间距、滚动原点、probe 状态、有效性、资源预算和 quality profile | 参数有界；相机负坐标/大跳变/resize 可重现；TS/Shader packing golden |
| G2 | 正式 capture：从场景几何、PBR 材质、emissive、方向/局部光和环境捕获辐射度；复用已有 capture pool/adapter | 不用测试色冒充场景；capture 失败不污染已发布 probe；资源有上限 |
| G3 | Probe occlusion/visibility，阻止墙后漏光；保守无数据 fallback | 薄墙、封闭房间、开门场景有基准；无 NaN、黑块和明显穿墙光 |
| G4 | dirty 区域：相机滚动、动态对象/灯光/emissive/剖切分别触发；每帧固定 probe 更新预算 | 静止停止更新；局部变化不全量刷新；迟到 capture 不覆盖新 revision |
| G5 | 主 PBR shader 三线性/多级采样；HDRI/IBL 为基础，GI 只补漫反射间接光 | 金属不吃漫反射 GI；AO/normal/emissive 组合正确；一次 tone map/sRGB |
| G6 | 屏幕空间补偿：复用已有 depth/normal/GTAO/TAA 历史，填补 probe 高频细节；history invalidation 明确 | 运动无明显拖影/闪烁；teleport、resize、device epoch、剖切会清无效历史 |
| G7 | 动态物体策略：接收 GI、可选择低频注入；不要求实时重烘焙 | 动态物体不在旧位置留下持续鬼影；预算不足显式降到 IBL |
| G8 | 画质/性能矩阵：开放厂区、封闭机房、动态输送线；静止、相机运动、灯/物体变化 | 截图 + 运动视频 + 原始 JSON；每维画质评分 ≥9/10；GI 关闭/IBL fallback 对照可重跑 |

“Lumen Lite”是产品简称，技术合同统一写 `Deep GI Lite`。不得宣称实现 UE Lumen 或与其功能等价。

## 8. 公共合同与完成定义

四个 Epic 共用以下规则：

1. 一个资源只能有一个生命周期权威：stage → validate → publish → submission-safe retire；取消、失败、迟到结果不得泄漏或抢回状态。
2. 预算同时覆盖 geometry、texture、buffer、atlas、probe、pipeline/manifest 估算；不能只统计方便的一部分。
3. 所有 capability、fallback、overflow、budget rejection 和 history reset 都输出稳定代码 + 人话原因，不允许静默换路径。
4. 所有新 schema/version 都有未知字段、未知版本、超限、重复 ID/hash、损坏数据、跨语言 golden。
5. Browser 与 Native 使用同一离线产物和逻辑身份；平台 GPU 对象可以不同，语义和降级必须一致。
6. 单元测试只证明局部；完成还要主 renderer 接线、Runtime Package 消费、真实 GPU、真实模型、失败路径和资源回落。
7. 每个修改/新增业务源文件尽量 <300 行，绝不超过 800 行；发现超大职责先拆，不通过删测试或放宽门禁规避。

每个 Epic 的最终证据放在 `test-output/deep-engine/p2/<epic>/<build-sha>/`（不提交运行日志/客户模型），至少包含：`report.json`、构建 manifest、资产来源/hash、adapter/backend、质量档、预算、P50/P95/P99、降级列表、截图和运动视频索引。可提交的冻结摘要与无敏感 golden 放入 `docs/specs/` 和测试夹具。

## 9. 验证命令

每个切片先跑聚焦测试，合流前至少执行：

```bash
pnpm --filter @bim-studio/deep-engine typecheck
pnpm --filter @bim-studio/deep-engine test
pnpm --filter @bim-studio/deep-engine build
pnpm --filter @bim-studio/deep-engine lab:build
pnpm --filter @bim-studio/deep-engine lab:isolation
pnpm --filter @bim-studio/deep-engine benchmark:residency-planner
cargo test --manifest-path packages/deep-engine-native/Cargo.toml
cargo fmt --manifest-path packages/deep-engine-native/Cargo.toml --all -- --check
cargo clippy --manifest-path packages/deep-engine-native/Cargo.toml --all-targets --all-features -- -D warnings
pnpm quality:source-size
pnpm gate:repository
```

真 GPU 仍需在 `pnpm --filter @bim-studio/deep-engine lab:serve` 后执行专项场景；Lab 地址 `http://127.0.0.1:5291` 只用于留证，不是产品完成证据。P2 最终还必须通过 P0 的完整 Studio Deep 后端入口和 Windows Native Runtime Package 消费。

## 10. 汇报模板与禁止误报

每次交接只报以下五项：

```text
切片：P2-Xn
改动：精确文件和行为
验证：命令、通过数、真 GPU/场景/adapter/build/asset hash
失败与降级：注入结果、资源回落、未覆盖项
下一依赖：唯一下一步及阻塞合同
```

以下都不能写“完成”：只新增类型；只有 CPU reference；只有 mock GPU；只有固定球体/测试色；只有单元测试；Lab 能跑但 `PbrRenderer` 未消费；Browser 完成但 Native 不识别 artifact；平均 FPS 变高但画质/峰值/跳样率没冻结；文档里出现了功能名。

## 11. GLM 第一批任务

第一批只做 P2-A1～A4，建议 2–3 人日：

1. 输出当前 bake/runtime-package schema 差异审计，不重写已有 `assetBakePlan`。
2. 设计并实现 v2 artifact 的 TS schema、严格验证、唯一序列化、hash/cache key 和 Rust golden reader。
3. 把现有 Meshlet/bounds/LOD/residency 数据装入 artifact；缺少的层级误差先做可验证 CPU reference。
4. 增加增量依赖图与取消/原子发布测试。
5. 通过 Browser/Native 聚焦门禁后再开始离线 CLI；未冻结合同前不要同时改四个 Epic 的主 renderer。

第一检查点交付物：v2 artifact 规格、TS/Rust golden、一个真实 GLB 的确定性 bake 报告、二次运行 cache hit、geometry revision 变化的局部 rebuild、取消后无半成品。完成这组证据后，才允许把 P2-N 和 P2-L 分给并行会话。
