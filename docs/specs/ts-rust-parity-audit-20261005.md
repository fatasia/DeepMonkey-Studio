# TS/Web 与 Rust/Native 能力一致盘点(2026-10-05)

> 用户指令:盘点 deep TS/Web 与 Rust/Native 双端能力一致性,产出盘点报告,不改代码。
> 方法:双端入口面(registers + 模块清单 + 金样合同)+ 四档分类 + native 深度抽查(读码实证)。
> 本报告只读码与金样,未运行 cargo/vitest(诚实条款见 §7)。

---

## 0. 现状核查(六步,2026-10-05 执行)

1. **全仓 grep**:双端入口 `packages/contracts/src/rendererCapabilityManifest.ts`、
   `packages/deep-engine-native/src/`(230 个顶层 .rs + 28 个子模块目录)、
   `packages/deep-engine/src/`(42 个域目录)均已读;工作树有 1 个未跟踪临时探针
   `packages/deep-engine/src/geometry/g1-probe.temp.test.ts`(未纳入盘点)。
2. **契约层**:`rendererCapabilityManifest.ts`(40 项,J4)已逐行读;
   `contracts/fixtures/renderer-capability-manifest.json`(金样,40 项,v1)已解析统计。
3. **依赖**:native 固定版 rapier3d 0.35.3(enhanced-determinism)、wgpu 30.0.1、
   cosmic-text 0.19.0、windows-sys 0.61.2 / windows 0.62.2;web 侧
   `@dimforge/rapier3d-compat` 0.19.3(apps/web)。双端 Rapier **版本不同**(见 §4.2 P 行)。
4. **消费方**:
   - native 消费 web:金样 include_str!(`renderer_capability_manifest.rs:24`)、
     共享 WGSL include_str!(`probe_gi_wgsl.rs:22` → `deep-engine/wgsl/probeClipmapSampling.wgsl`
     + .sha256 门)、runtime package(web `runtimePackage/builder.ts` → native `runtime_package/`)。
   - web 消费 native:间接——Studio 发布 runtime package 由 native player
     (`main.rs`+`cli.rs`,含 viewer/telemetry/动态回放/遮挡 smoke 等子命令)消费;
     `apps/web` 无对 native crate 的直接调用。
5. **既有审计**:`docs/specs/engine-capability-consumption-audit-20261003.md`(引擎→宿主
   消费,TS 单侧,与本任务 TS↔Rust 正交,不重复建设);其 §3 遗留
   instance-outline 登记已在本清单 `object-outline` 行闭环(双端 full)。
6. **规格文档**:`docs/specs/i-c23-material-consumption-next-20261001.md`(分层材质 native
   消费边界)、`docs/handoffs/gi-depth-handoff.md`(清单 sdf-gi 行引用)已核。

---

## 1. 双端能力总量统计

| 维度 | TS/Web(packages/deep-engine + contracts + apps/web) | Rust/Native(packages/deep-engine-native) |
|---|---|---|
| 源文件总量 | deep-engine 1,856 个 .ts(含 754 个 .test.ts),contracts ~130 个合同文件 | 707 个 .rs(230 顶层 + 子模块),含 183 个 *test*.rs |
| 域目录 | 42 个域(adapterN1…webgpu) | 28 个子模块目录(adapter_n1…shadow_update_classify)+ ~80 个顶层 pub mod |
| 可执行入口 | 无(vite/浏览器宿主) | `main.rs`(player + CLI 分派)+ `src/bin/industrial-worker-host.rs`(工业 Node reader 沙箱宿主) |
| 渲染能力登记 | 40 项全登记(web:39 supported + 1 degraded) | 40 项全登记(native:11 supported / 6 degraded / 23 unavailable) |
| 双端一致机制 | J4 登记表 + web 自检 `rendererCapabilitySelfCheck.ts`(实际面派生) | `renderer_capability_manifest.rs` 三层漂移检测 + 金样 include_str! + 共享 WGSL .sha256 |

**渲染 40 项金样分布**(解析自 `fixtures/renderer-capability-manifest.json`):

| 端 | supported/full | supported/opt-in | supported/harness | degraded | unavailable/absent | api-missing | host-specific |
|---|---|---|---|---|---|---|---|
| Web | 22 | 16 | 1 | 1(harness) | 0 | 0 | 0 |
| Native | 10 | 0 | 1 | 6 | 21 | 1 | 1 |

**一致度速览**:40 项中 **11 项双端同档**(10 双 full + 1 双 harness 白炉)、
**6 项 native 降级**、**1 项按设计 host-specific**、**1 项登记漂移**(§3.1)、
**21 项 web 独有**(native absent)。

---

## 2. 渲染能力 40 项逐行矩阵

依据:TS 登记表 + native 自检 + 金样 + 本轮读码复核。"复核"列为本审计新增事实。

### 2.1 双端一致(11 项)

| id | 域 | web | native | 复核 |
|---|---|---|---|---|
| bloom | Bloom 辉光 | full | full | bloom/bloom_pass/bloom_pipeline 三模块在,quality_profile 预算在 |
| tonemap-display | ACES 色调映射 | full | full | native-aces-v1/light-v2 + author_grading 前置 HDR 域 |
| ibl-environment | IBL 环境光 | full | full | gpu_ibl.rs + ibl/(panorama/sampling/validation) |
| texture-arrays | 纹理数组化 | full(opt-in) | full | texture_array_packing 与 Web 同源 |
| occlusion-culling | 视锥/遮挡剔除 | full | full | gpu_culling + gpu_occlusion* + renderer/hi_z_pyramid(R4 opt-in) |
| gpu-lod | GPU LOD 选择 | full | full | lod_contract 与 Web 合同同源 |
| shadow-cascades | 级联阴影 | full | full | 注:native 仅级联档,web 另有 virtual clipmap 三环档;native 登 full 系"直出按设计单档"口径,虚拟档未镜像(如实注记,不判漂移) |
| shadow-local | 局部光阴影 | full | full | local_shadow 16 spot/16 view + 点光 6-face |
| ies-lighting | IES 配光 | full | full | ies_shading 字节布局镜像 E02 表 |
| object-outline | 对象描边 | full | full | outline_pass + native_outline_composite_v1.wgsl,bit 256 双端共用 |
| white-furnace-conservation | 白炉守恒 | harness | harness | 双端逐式移植,容差字面量测试锁定 |

### 2.2 native 降级(6 项)

| id | web | native 现状 | 差距实质 | 建议切片/工时级 |
|---|---|---|---|---|
| material-abi-192b | full(192B 打包) | degraded(160B 核心块,扩展带零填充回退) | native 不消费扩展 40..48 | native 扩展带着色消费(与 material-clearcoat 合并做)3–5 人日 |
| gi-probe-directions | full(16/32 方向 + L1 SH 方向可见度) | degraded(直光种子 producer + 96B 布局合同;另 probe_gi_grid.rs v2 多层级联网格头合同 + CPU 三线性参考已入库,**着色消费端未接,dead_code 放行**——清单未提及该 v2,登记略滞后但档位不变) | native 无方向辐射内核采样通路 | 切片:probe_gi_grid v2 着色消费接线 5–8 人日 |
| fog-volumetric | full(半分辨率体积 march) | degraded(屏幕空间固定步线性深度积分) | 非 froxel 体积管线 | froxel 升级 3–5 人日(工业出片收益中) |
| author-grading-vignette | full | degraded(六通道已镜像,vignette 槽位恒未启用) | 只差一个开关+着色行 | **0.5–1 人日,性价比最高之一** |
| device-recovery | full(分型+状态机+退避) | degraded(DeviceLost 整渲染器重建) | 无错误分型/阶段机/次数预算 | 移植 classifyDeviceLost 语义 2–3 人日 |
| local-shadow-abi-16 | full | degraded(frame v8 布局"未跨端逐字节对齐验证") | 唯一缺口是对拍验证本身 | **frame v8 双端 golden 对拍 1–2 人日**(补 SHA-256 fixture 即可闭环) |

### 2.3 web 独有 / native absent(21 项,按域分组)

| 组 | id(native=absent 除注明) | 建议切片/工时级(按工业主线价值) |
|---|---|---|
| GI/光照 | sdf-gi;ambient-occlusion;megalights(api);contact-shadows | **sdf-gi 切片一**(场景 SDF 烘焙+天光圆锥追踪)8–12 人日;SSAO 3–5 人日;megalights RIS 万灯 8–15 人日(厂房大屏核心);contact-shadows 3–5 人日 |
| 时域/显示 | taa;temporal-upscale;spatial-aa;hdr-display-output(host-specific 相邻);debug-full-render(排查工具,按设计 web) | TAA 5–8 人日(时域历史链是 TSR 前置);TSR 8–12 人日;FXAA **1–2 人日**;HDR 出片属 web 宿主,可登记 host-specific |
| 材质 | material-clearcoat(基材扩展带;注:native **已有** pbr_layered.rs 304B 分层材质+活动层清漆复用 T08 核+layered_*_gpu_tests,清单**无对应能力行**,见 §3.2);material-advanced | 分层材质登记 0.5 人日 + 活动层清漆直射收尾(依 i-c23 文档)2–3 人日;advanced 带全量 8–12 人日 |
| 几何 | visibility-buffer;cluster-lod;virtual-textures;virtual-geometry(web 侧也仅 harness) | virtual-geometry:native geometry_dag 离线工具链 8–12 人日 + web M3 GPU 接线 5–8 人日(大模型性能主线);其余各 8–15 人日 |
| 环境 | atmosphere-sky;ground-preview | 大气散射预计算表采样 3–5 人日;内置地面/网格 **0.5–1 人日** |
| RT | hardware-ray-query(**登记漂移**,native 实际有 F2 硬件 RT,见 §3.1);ray-traced-shadows(native 实际有硬件 RT 方向阴影管线族,与 web compute BVH 为不同实现档) | 登记修正 0.5 人日(纯登记,先行) |

### 2.4 完全一致机制(非行级)

- 设备恢复桥 device-recovery-bridge:host-specific,双端登记合理。
- 三层漂移检测(`renderer_capability_manifest.rs` 测试 ×5):金样解析/词汇合法、
  native 自检↔金样 native 列逐词一致、id 覆盖互斥、原因码配对合法——本轮确认为**双边
  生效**;但 **TS↔金样这一环无测试**(§3.3)。

---

## 3. 审计发现(漂移与机制缺口,本报告核心增量)

### 3.1 漂移:hardware-ray-query / ray-traced-shadows 的 native 列落后于实际面

- 登记表(基线 2026-09-29)写 native `unavailable/api-missing`,证据
  "wgpu 30 无 RT 特性;rt_residency.rs 仅驻留+绑定,**不做像素消费**"。
- 事实(commit 227958ca,2026-09-23,**早于清单基线**):
  - `gpu_context.rs:67-104`:适配器含 `wgpu::Features::EXPERIMENTAL_RAY_QUERY` 即启用
    (wgpu 30 暴露该实验特性,"api-missing"前提不成立);
  - `pipeline/rt.rs`:F2 RT fragment 像素消费管线族(TLAS binding 10、
    `enable wgpu_ray_query;`、opaque/MASK 方向阴影 Ray Query 变体,
    失败 error-scope fail-closed 回退栅格);
  - 接线:`mesh_pass.rs`、`gpu_scene_draw.rs` 消费 `RtMeshPipelines`(生产绘制路径,
    非死代码);测试:`renderer/rt_pixel_gpu_tests.rs`、`rt_raster_parity_gpu_tests.rs`、
    `rt_layered_gpu_tests.rs`、`rt_recovery_gpu_tests.rs`;
  - `ray_tracing_capability.rs`:DXR 硬件诊断探针(与渲染设备分离,fail-closed)。
- `host_capabilities/rt_probe.rs` 未探实验特性,与 F2 通路口径不一(探针窄于实际)。
- **影响**:J4 纪律第 1 条"只做一端=清单漂移会被打红",但现有对拍只校验词形一致性
  (native 自检↔金样),不校验事实真实性——此漂移**不会被任何测试打红**。
- **建议**:按纪律重登记(hardware-ray-query native → supported/opt-in-default-off,
  证据指 `pipeline/rt.rs`;ray-traced-shadows native → degraded/reduced-tier 或另行
  拆分"硬件 RT 阴影"行),重生成金样,rt_probe 增补实验特性探测。**0.5–1 人日,先行**。

### 3.2 缺行:分层材质(I-C23)双端已落地,登记表无对应能力

- web:`shader/materialLayeredParameters.ts`、`packLayeredSurfaceBlock` 304B 布局、
  `materialLayerBlend.wgsl` 唯一真源核;
- native:`pbr_layered.rs`(304B = header 16B + 2×144B,`LAYERED_SURFACE_ABI_VERSION=1`
  与 TS 互钉)+ `contract/validate_layered_params.rs` 发布守卫 +
  `renderer/layered_*_gpu_tests.rs` ×6(清漆/组合/金属反射/纹理/白炉分层/RT 分层);
- 分界(依 i-c23 文档):native 基材扩展/各向异性/透射保持发布拒绝,活动层清漆为
  后继切片——因此 material-clearcoat 行 native=absent 的**口径仍成立**,但
  "材质分层栈"作为一项双端能力应独立成行登记,否则它游离在 J4 纪律之外。
- **建议**:新增 `material-layered-304b` 行(双端 full/opt-in),0.5 人日。

### 3.3 机制缺口:三方对拍缺 TS↔金样一环

- 清单头注释宣称"双端与金样三方对拍"、自检模块注释宣称"contracts 侧对拍红";
- 事实:`rendererCapabilitySelfCheck.ts` **无任何消费测试**(全仓 grep 仅 6 个非测试
  引用);`contracts` 无 `rendererCapabilityManifest.test.ts`(src 目录逐文件核实;
  package.json `--passWithNoTests`);金样 JSON 无生成器脚本、无 TS 侧对拍测试——
  **TS 登记表改了而金样忘更,只有 native 自检恰巧不一致时才会红,web 列漂移完全无拦截**。
- **建议**:补 contracts 测试:`rendererCapabilityManifestJson()` 输出与提交金样逐字节
  相等(生成即验证)+ 自检行↔登记表 web 列逐词对拍。**0.5–1 人日,先行**。

### 3.4 轻微滞后

- `gi-probe-directions` native 证据未提 `probe_gi_grid.rs` v2 多层级联网格 GI 头合同
  (v2 布局头 + CPU 三线性采样参考已入库,消费端 `#![allow(dead_code)]` 显式未接)。
  档位(degraded)无需变,证据应补。
- `shadow-cascades` native=full 系"直出单档按设计"口径,web 的 virtual clipmap 档未
  镜像(登记时已如实注记,建议行内补"virtual 档 native 不适用"字样,避免误读)。

---

## 4. 非渲染域四档分类矩阵

**档例**:①=双端有且互认/对拍;②=native 有而 web 未消费(native player 专属或未接线);
③=web 有而 native absent;④=双双都缺。

| 域 | TS/Web 能力 | Rust/Native 能力 | 档 | 一致度/差距 |
|---|---|---|---|---|
| 物理-刚体/角色 | apps/web rapier3d-compat **0.19.3** + `delivery/compileScenePhysicsRuntime.ts` + contracts/scenePhysics(kinematic/fixed/dynamic、collider 五源、精度标记) | `native_physics.rs` rapier3d **0.35.3** enhanced-determinism + CCD/金样/机构(motor-gear/slider)金样 | ① | 双端各自 Rapier,合同在 contracts+包 ABI;**版本不同轨**,确定性跨端不承诺(如实) |
| 物理-软体/布料/发/破碎/车辆 | `physics/` 82 文件(cloth GPU、softBody 并行、hairChain、fracture、vehicle,含 checksum 门) | 无(仅碰撞网格提取) | ③ | 最大单域缺口;工业仿真需要时逐域移植(评估先行) |
| 物理-SDF 碰撞 | `physics/sdfCollisionBridge.ts` | `physics_sdf_mesh.rs`(Freudenthal/Kuhn,逐位同构,SHA-256 fixture 对拍) | ① | 逐位一致,模范样本 |
| 2D 渲染 deep2d | `runtimePackage/deep2d.ts`(显示列表合同/作者端) | `deep2d/` 全栈(painter/atlas/clip/dash/polygon/GPU vertex transfer/缓存预算)+ 14 个 GPU 测试文件 | ①合同 + ②运行时 | 运行时仅 native 消费(按设计,离线出片) |
| 图表 chart | contracts/dashboard* + `runtimePackage/chart.ts`;宿主图表为 ECharts(作者端) | `chart/` 全栈(IR/轴/图例/GPU 几何/交互/模拟/回放/数据窗口) | ①合同 + ②运行时 | native 自绘图表栈完整;web 不消费(native player 出片用) |
| 仪表盘运行时 | `runtimePackage/dashboard*`(composition/filter/table/textInput/video 合同+校验) | `dashboard_runtime/`(compose/filter_multi/select/typeahead/text input/hit/simulation/report_save)+ app/ 12 文件 | ①合同 + ②运行时 | 同上 |
| 文本排版/IME | 浏览器原生(无自研) | `platform_text/` cosmic-text 全栈(shaping/raster/glyph atlas/IME 会话/文档编辑/字体能力报告) | ② | native 专属;web 按设计不需要 |
| 无障碍 | DOM 无障碍 | `native_ui/` retained UI + UIA bridge + chart_a11y + virtual_list + design_tokens | ② | native 专属 |
| 沙箱进程治理 | 无 | `compat_x/`(Job Object/LPAC/调度器/IPC)+ `bin/industrial-worker-host.rs`(工业 Node reader 有界 stdio 宿主) | ② | 服务工业格式导入链的隔离执行器;web 经文件/CLI 间接受益 |
| 回放/行为 | contracts 无对应合同 | `replay.rs`(固定步统一回放器,canonical JSON+SHA-256 display hash)+ `behavior_ir/`(命令总线)+ `behavior_extension/`(签名注册表/gate) | ② | native 独有且无 TS 合同;若要 web 行为编辑器,先立双端合同(4–8 人日) |
| 着色器包/缓存 | `shaderPackage/builder` + `shaderCache/`(IndexedDB/prewarm/LRU) | `shader_package/`(schema v2/abi/executor/validate)+ `shader_disk_cache/` | ①合同 + ②缓存 | 包 schema 双端同源;缓存各宿主各自实现(按设计) |
| N1 适配器 | `adapterN1/`(SVG 子集/富文本/图表扩展/动画 ABI,fail-closed) | `adapter_n1/`(同构 + 认证台账/摘要 fail-closed 矩阵) | ① | 金样对拍,模范样本 |
| 世界分区/流送 | `rayTracing/worldPartition.ts`+`worldChunkBridge.ts`;`hlod/` 包;`streaming/` GPU 驻留执行器 | `world_partition.rs`+`world_chunk_bridge.rs`(逐语义镜像);HLOD chunk 消费;无 GPU 驻留执行 | ①数学 + ③执行 | 分区/桥双端一致;GPU 流送执行仅 web |
| 动画 | `animation/` + delivery 动态回放 | `native_animation_*`(状态机 R11/事件/根运动/时钟) | ① | 状态机与 Web `DynamicAnimationControllerPlayer` 一一同构 |
| 探针 GI 采样 | `gi/` 全栈(SDF 烘焙/SH 更新/发布/昼夜 harness) | `probe_gi_abi` + `native_gi_producer` + `probe_gi_grid` v2(合同先行,**消费未接**) | ②部分 | 见 §2.2 |
| 相机/导航 | three 桥 + viewer 控制(宿主) | `runtime_camera/coordinates/navigation(+crowd)` 确定性导航数学 | ② | native 独有(注明"Web parity 仍需输入回放与碰撞集成"——模块头自述) |
| 遥测 | `perf/` | `telemetry(_gpu/_sample_window)` | ① | 各自面向宿主,机制同构 |
| 工业格式导入 | contracts/modelFormatCapability + `gltf/` + web inspector | `contract/validate*`(几何/UV/纹理/分层参数/金属反射)+ `asset_package/`(license/validation/recovery)+ `x_package_source` | ① | 包契约双端;解析主体按工作区约束在自研链(另行盘点) |
| 离线视频/帧导出 | `r12/frameCapture`(帧捕获) | `dashboard_video/`(Media Foundation)+ player 遥测出图 | ② | 出片链 native 专属 |
| 高斯泼溅 | `gaussianSplat/` 全栈(解码/排序/GPU 资源/场景槽) | 无 | ③ | 工业点云孪生价值高,移植评估优先 |
| 地形 | `terrain/`(field/heightfield/scatter) | 无 | ③ | 按需 |
| 粒子 | `particles/` 全栈(流场/曲线 LUT/排序/预算,宿主已接 15 文件) | 无 | ③ | 大屏动效价值;native 出片需要时移植 |
| 形变/姿态 | `deformation/`+`morph/` | 动态动画 TRS 采样(部分) | ③部分 | 骨骼姿态链 native 无 |
| DXR/RT 能力探针 | JS 能力探针(rayTracingCapabilities 等) | `ray_tracing_capability.rs`+`host_capabilities/rt_probe.rs` | ① | 口径缺口见 §3.1 |
| 路径追踪 | web 并行分块路径追踪(消费审计 §2:12 文件) | 无 | ③ | 离线出图价值高,native 侧候选 |

**档④(双双都缺)实例**:全仓双端零命中 `depthOfField / motionBlur / subsurface`;
即景深、运动模糊、次表面散射、全动态体素 GI、anamorphic 光斑等——登记表外,双端均无,
如立项需按 J4 纪律先登记双端 unavailable。

---

## 5. 关键差距 Top10(按工业数字孪生主线价值排序)

| # | 差距 | 建议切片 | 工时级 |
|---|---|---|---|
| 1 | F2 RT 登记漂移(§3.1) | 重登记 hardware-ray-query/ray-traced-shadows native 列 + 金样重生成 + rt_probe 补实验特性 | 0.5–1 人日(**先行**) |
| 2 | TS↔金样对拍测试缺席(§3.3) | contracts 补两个测试(金样逐字节相等 + 自检↔登记表对拍) | 0.5–1 人日(**先行**) |
| 3 | 分层材质未登记(§3.2) | 新增 material-layered-304b 行 + 活动层清漆直射收尾(依 i-c23 边界) | 2.5–3.5 人日 |
| 4 | local-shadow-abi-16 降档唯一缺口=对拍缺失 | frame v8 双端逐字节 golden 对拍(SHA-256 fixture,沿 F6 先例) | 1–2 人日 |
| 5 | native 视觉低成本三件套 | vignette 启用 + FXAA + auto-exposure(直方图 EV 包络移植) | 3–5 人日 |
| 6 | native SSAO absent | Hi-Z 复用 + 半分辨率 AO pass(坑位与 cascaded/hi_z 同栈) | 3–5 人日 |
| 7 | native sdf-gi 全缺(GI 主线) | 切片一:场景 SDF 烘焙+天光圆锥追踪(compute,共享 WGSL 链);切片二:探针 SH 更新+发布 | 8–12 人日 / 6–10 人日 |
| 8 | megalights native absent(厂房万灯出片) | 依赖 native compute 光照栈;先移植灯池 ABI(64B/灯)与 RIS 核 | 8–15 人日 |
| 9 | virtual-geometry 双端都在建 | native:geometry_dag 离线工具链;web:M3 GPU 上传+主 pass 接线 | 8–12 / 5–8 人日 |
| 10 | 物理域版本分轨+软体缺口 | 先立双端确定性合同(rapier 版本对齐评估);cloth/softbody 移植可行性评估 | 评估 2 人日;移植 15+ 人日 |

排序理由:1–4 是"一致性地基"(不修则后续每刀都在漂移的地基上盖楼,且成本极低);
5–6 是出片质感/成本比最高的视觉项;7–8 是 GI 与万灯两条质量主线;9 是大模型性能主线;
10 是工业仿真可信度主线。

---

## 6. 结论

- 双端**合同基础设施**(J4 登记表/金样/native 三层漂移检测/共享 WGSL checksum 链/
  identity golden)是同类项目少见的完备,11 项渲染能力双端同档、物理 SDF/N1/世界分区
  等域有逐位对拍模范样本。
- 真实风险不在"没有机制",而在**机制未闭合**:(a) 对拍只校验词形不校验事实,F2 RT
  漂移证明了这一点;(b) TS↔金样一环无测试;(c) 分层材质等新双端能力游离在登记外。
  三项修补合计 ≤3 人日,建议最优先。
- 能力差距主体是 web→native 的后处理/GI/几何三族(21 项 absent),其中 4 项 ≤1 人日
  即可摘(vignette/FXAA/auto-exposure/地面网格),适合作为 native 视觉追平的第一波。

## 7. 诚实条款(未验证/未覆盖)

1. 本报告**只读码与金样,未运行** `cargo test` / `vitest`;测试生效性依据源码断言与
   模块声明,未实跑验证。
2. `probe_gi_grid.rs` v2 消费状态依据头注释(`#![allow(dead_code)]`),未运行验证。
3. F2 RT "已接线生产绘制路径"依据 `mesh_pass.rs`/`gpu_scene_draw.rs` 对
   `RtMeshPipelines` 的符号引用与 GPU 测试文件存在性,**未真机运行**确认逐帧生效。
4. 工时为估计级(按本仓切片粒度类比),未排期、未评审。
5. contracts 中业务域合同(worldApi/opcUaLive/digitalThread/robot/ppr/battery/
   industrialAi/plantAnalytics 等约 60 文件)按设计 native 不涉及,本轮仅验证
   "无渲染/物理类 native 对应物",未逐文件核对,不作为缺口登记。
6. native `wasm32` target(`platform_text` 有 wasm 分支、wgpu web 依赖)能力面未盘点。
7. 盘点基于 2026-10-05 工作树(含当日 GI M3/MegaLights 三个提交 b8d31011/83ebf18e/
   2389efa2 之后的状态);清单行随提交演进,后续以 J4 纪律同步为准。
