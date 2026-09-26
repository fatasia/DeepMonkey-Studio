# T00 样本、基准与证据基线

日期:2026-09-26。工作包:T00(《Deep Engine 核心能力开发执行计划》W0 入口卡,计划第 5 节)。
状态:partial(可复跑对照已按当前 HEAD 落档;S1–S8 负载目标多数未达,逐项见第 4 节)。
本报告只登记现状与证据,不宣称任何工作包已验收;当前 24 个工作包仍全部 pending,本文为 T00 的执行记录。

## 0. 现状核查(六步)

| 步骤 | 核查结果 | 执行动作 |
|---|---|---|
| 源码与未跟踪文件 | HEAD `e616677a`;工作树有 2 个已跟踪文件改动(`apps/web/src/viewer/deepCameraInputSession.ts` +13 行、`packages/plant-lite-simulation/src/perf/bench.test.ts` +36 行)与若干未跟踪文档/探针脚本/发布资产 | 已登记进第 1 节基线口径;复跑结果包含该未提交输入会话改动,已显式声明 |
| 契约与类型 | `benchmarkAssetManifest`/`benchmarkSampleSchema`/`benchmarkAssetTrajectory`/`benchmarkTargetMatrix` 四个基准合同及 fixtures 已存在(`packages/deep-engine/src/benchmark*.ts`、`packages/deep-engine/fixtures/benchmark-assets/*.json`,commit `36c9fcf3`) | 样本清单直接按 `benchmarkAssetManifest` 合同口径登记,不新建平行格式 |
| 依赖 | Three 0.185.1、Web Rapier、playwright(sharp 用于 SSIM)均已在用 | 复跑直接用 `node scripts/gate-deep-fair-comparison.mjs`,无新增依赖 |
| 消费方 | `gate-deep-fair-comparison.mjs` 被 09-25 以来 20+ 次对照运行消费(ab-baseline 至 cut9);`benchmark:render-engines` 独立自包含(自建 dist+静态服务) | 选 fair-comparison 复跑:更贴近 T11 关心的输入帧/首帧口径且无需 dist 构建 |
| 测试与证据 | `test-output/` 已有 render-engine-comparison、deep-fair-comparison 全系列 20+ 目录、perf-evidence、native-web-paired-performance;`docs/reports/performance-and-capability-upgrade-analysis-2026-09-25.md` 有第二批(09-26)实测记录 | 历史结果保留原目录不动,新测结果单独落 `test-output/deep-core/T00/<run-id>/`;不把旧结果记为本次验收 |
| 规格/交接 | 计划文件、122 项审计都在 `docs/` 下(未跟踪);工业格式权威计划 `docs/specs/industrial-3d-format-work-plan-2026-09-16.md` 仍缺失,但其样本语料与依赖锁定的实物在 `data/external-assets/industrial-format-plan/`(corpus-manifest.json + 7 份 SHA256SUMS) | T22 校准仍以"恢复权威文件"为前置;样本清单(第 5 节)已按现有 corpus-manifest 可核验口径登记 |

## 1. 运行环境与基线口径

### 1.1 环境

| 项 | 值 |
|---|---|
| 仓库 / HEAD | `D:\Documents\bim\bim-studio` @ `e616677ab059b5acc1873e2266d80c9dfa44d26b` |
| 进行中改动(影响基线,必须声明) | 复跑启动时(16:52)已存在:`apps/web/src/viewer/deepCameraInputSession.ts`(+13,未提交,进入本次全部复跑)、`packages/plant-lite-simulation/src/perf/bench.test.ts`(+36,不影响复跑路径)。**复跑窗口内(截至 17:10)检测到并行会话继续在同一 checkout 工作**:工作树从 13 项漂移到 24 项(新增 `modelStructure.ts`/`ModelStructureTreePanel.*`/`api.ts`/`modelAssetRoutes.ts` 等改动)。因此本报告全部数字是「HEAD `e616677a` + 漂移中工作树」的实测;归因类结论(T11 输入 P95 A/B)必须在干净 checkout 上重测 |
| OS | Windows 11 家庭中文版,build 10.0.22621.4317 |
| CPU / 内存 | Intel Core i9-12900HX / 31.8 GB |
| GPU | NVIDIA GeForce RTX 4060 Laptop GPU,驱动 32.0.15.9579(另存在 OrayIddDriver 虚拟显示设备,未参与渲染) |
| 浏览器 | Chrome 153.0.8010.53,`--enable-unsafe-webgpu --enable-features=Vulkan,UseSkiaRenderer` |
| Node / pnpm | v24.18.1 / 11.18.0 |
| 电源/温度 | 未控制、未采样 → **unmeasured**(笔记本,结果受散热策略影响,横向比较需同状态) |

### 1.2 固定相机 / 输入 / seed 协议(fair-comparison,本次复跑所用)

- 场景与路由:项目「智造综合案例验证」(`38ea81ba-3033-4d3e-86b5-648fd58d98f1`)场景「678 - 副本」(`fedab835-389b-43a5-99be-6820d0f3afde`),自 2026-09-25 ab-baseline 起全部对照运行同一路由。
- 场景输入冻结:场景文档 JSON SHA-256 `58fa40d7f99a001ce81f2977768f7f9e6ab0dbc2da76b890582d57d2aeeedf03`(15248 字节,存档 `test-output/deep-core/T00/s1-scene-frozen.json`);其实际加载几何 `geometry.glb` SHA-256 `7d646315a20d47ec4484626efbed17c6a018c4e3da1ef7d3f15fc9d35c9656dc`(5116 字节)。
  **缺口**:场景文档 hash 依赖 dev 数据库状态,发布管线未把场景 revision 写进对照报告 → T11 开工时改为从报告内捕获 revision/hash。
- 相机:每后端先"适应整个场景"复位,再依次测 (a) 静置 120 帧帧时间;(b) 前/右/顶三个固定位姿截图(像素守卫);(c) 固定正弦输入轨迹 120 步。位姿定义在脚本内,未参数化 → 与 `benchmarkAssetTrajectory`(asset-bounding-sphere 归一化系,fixtures-v1 已冻结)是两套轨迹体系,后者是 T00 之后统一基准的正式口径。
- seed:渲染对照以确定性 SSIM 为准(固定位姿重复截图 SSIM=1.0 通过);物理/仿真 seed 固定在 golden 测试内部(`goldenPlant.test.ts` 的 `SEED`、Rapier 固定版本)。WebGPU 抖动序列由 TAA 内部固定。**未建立跨场景统一 seed 登记**,第 4 节列为缺口。
- 判定:跨后端 SSIM 只记录(画风差异不作失败);黑帧/亮度/自身确定性是硬守卫;`exceeds` 只在 Deep 后端全核心指标不劣于 WebGL 时为 true。

## 2. 复跑结果(当前 HEAD 实测)

运行目录:`test-output/deep-core/T00/fair-r{1..7}-20260926-e616677a/`(每目录含 report.json/report.md/三后端位姿+重复截图/输入轨迹末帧)。

### 2.1 干净通过运行(r1、r2,端口 5173)

| 指标(ms,除非注明) | WebGL | Deep WebGPU | Deep WASM |
|---|---|---|---|
| 静置帧时间 P50 / P95 / P99(r1) | 7.0 / 7.1 / 34.8 | 6.9 / 7.1 / 7.2 | 7.0 / 7.2 / 14.0 |
| 静置 P95(r2) | 7.1 | 7.3 | 7.2 |
| 输入帧 P95(r1 / r2) | 13.8 / 7.2 | 20.9 / 20.8 | 13.9 / 13.9 |
| pointer→submit P95(r1 / r2) | 2.4 / 1.5 | 2.4 / 2.8 | 3.4 / 47.8(r2 异常,见 2.4) |
| pointer→GPU complete P95(r1) | null(无 timestamp) | 49.5 | 82.1 |
| 切后端首帧 wall(r1 / r2) | 803 / 803 | 4611 / 5024 | 2688 / 3036 |
| 黑帧 | 0 | 0 | 0 |
| 拖拽有效 FPS(r1 / r2) | 50 / 50 | 50 / 0(r2 的 dragSmoothness 采样异常) | 50 / 0(同左) |
| 位姿确定性 SSIM(自身重复) | 1.0×3 位姿 | 1.0×3 | 1.0×3 |
| Long Task(r1) | 5 | 3 | 15 |

GPU complete 缺 WebGPU timestamp 的帧无 null 之外的口径 → GPU 通道在部分样本上 unmeasured,不填零。

### 2.2 与历史记录的对照(口径不同,不能直接替换)

| 指标 | 09-26 报告值(实施记录·第二批) | 本次 HEAD 复测 | 差异解释(已核查) |
|---|---|---|---|
| pointer→submit P95 | 2.1ms | 2.4 / 2.8ms | 同量级,一致 |
| 静置 P95 | 7.1 vs 7.2ms | 7.1 / 7.3ms | 一致 |
| 输入帧 P95 | 14.0ms(cut7b/cut7c) | **20.8–20.9ms** | 高 ~50%。cut7 之后合入了 `d0c9afc5`/`416f8508`/`227fd612` 等,且工作树有未提交 `deepCameraInputSession.ts` 改动;**未做归因**,列入 T11 首项复测(需在同一 commit 上做含/不含该改动的 A/B) |
| 切后端首帧 | 1.57s(双切暖缓存探针口径,`d0c9afc5`) | **4.6–5.0s(首切冷缓存口径,fair-comparison 内置)** | 两个口径并存:1.57s 是"双切探针第二次切换",本次是脚本首切(packet 编译冷缓存,scene-uploaded 占 2.75s)。两口径都保留;T11 验收须同时报首切与暖切 |
| WebGL 首帧 | ~0.84s | 803ms | 一致 |
| 黑帧 | 0 | 0 | 一致 |

历史冷缓存参照:cut9(HEAD `923f1ca4`,2026-09-26 上午)首切 4366ms、输入 P95 41.8ms → 本次 HEAD 20.8ms 在输入帧上有改善,首切仍 ~4.6s。

### 2.3 全部独立运行台账(含失败,诚实登记)

| run | 时间 | 5173/5199 | 结果 | 说明 |
|---|---|---|---|---|
| r1 | 16:52 | 5173 | passed,guards 0 | 干净基线 |
| r2 | 16:55 | 5173 | passed,guards 0 | wasm pointer→submit P95 47.8ms、effFps 0 采样异常 |
| r3 | 16:56 | 5173 | **failed** | 5×HTTP 502(Vite 代理→4100),仅测完 webgl |
| r4 | 16:58 | 5173 | **failed** | 18×502 + locator 超时,同因 |
| r5 | 17:00 | 5173 | **failed** | 同因(间歇 20s 后复跑) |
| r6 | 17:01 | 5173 | **failed** | 同因 |
| r7 | 17:04 | 5199(新起干净 Vite) | passed,guards 0 | WebGPU 静置 13.9 / 输入 62.5 / WASM effFps 6.7——冷 dev 服务按需变换与渲染争 CPU,**环境污染样本**,不作性能基线,仅作环境敏感性证据 |

**T00 发现(交付给 T11 的协议缺口)**:fair-comparison 对同一 dev 服务连续运行 ≥3 次后,Vite 代理 `/api/*` 稳定出现 502 楔死(直接 curl 4100 正常),需重启 dev 服务或换端口才能恢复。这解释了历史 run 目录均单次运行的原因。三次独立运行验收由 r1/r2/r7 满足,其中 r7 为不同服务状态(已声明)。

### 2.4 测量口径缺陷登记(复测前必须修)

1. **WASM 首帧阶段分解无效**:r1 中 wasm 的六阶段 mark 与 webgpu 完全相同(`marksBefore:11`,performance mark 全局残留),只有 wallMs(2688/3036)可用。
2. **dragSmoothness 采样偶发全零**(r2 wasm/webgpu effFps=0),p95 类指标建议以 3 次干净运行中位数入账。
3. GPU timestamp 通道在部分帧不可用 → `pointerToGpuComplete` 按帧数报告,缺失帧计 unmeasured。

## 3. 历史对照资产(复用,不重跑)

- `test-output/render-engine-comparison/`(schema v2:三/双引擎 120/1000 对象×静置/动态,自建 dist 静态服务;本次未重跑,保留为 `benchmark:render-engines` 的可复跑入口)
- `test-output/deep-fair-comparison-ab-baseline-20260925/` 至 `cut9-packet-cache-20260926/`:20 个目录,构成 09-25→09-26 优化链(提交背压/修订缓存/packet 缓存)的逐 cut 证据
- `docs/reports/performance-and-capability-upgrade-analysis-2026-09-25.md` 第二批记录(submit 拖尾 47.4→2.1ms、输入 20.8→14.0ms、双切首帧 3.9→1.57s)
- GPU 测试脚本族(`packages/deep-engine` package.json):`test:probe-radiance-gpu`、`test:cluster-lod-gpu`、`test:g7-volumetric-fog-gpu`、`test:ray-trace-gpu`、`test:probe-occlusion-gpu`、`test:probe-grid-bake-gpu` 等;本次均未运行(需要独占 GPU 窗口,列入 T01/T02/T05/T10 开工首步),相关历史结果不在本次新证范围

## 4. S1–S8 场景映射与缺口清单(计划 §6.1)

| 场景 | 现有可映射资产/场景 | 覆盖判定 | 缺口(T00 结论) |
|---|---|---|---|
| S1 标准工业车间(1 万重复实例) | 「智造综合案例验证/678-副本」(fair-comparison 固定路由,单 GLB 5KB+2 图元,hash 已冻结);`benchmarkTargetMatrix` 的 `factory-instances` 负载类;轨迹 fixture `fixture.factory.animation-replay` | **协议已冻结,负载远未达** | 当前对照场景是 5KB 小模型,静置 P95≈7ms 属 vsync 饱和而非负载;1 万实例场景不存在,需生成并走 `benchmarkAssetManifest` 登记 |
| S2 建筑室内外(薄墙/开门/玻璃/昼夜) | probe GI 测试合成小场景(`probeSurfaceCache`/`probeClipmap*` 测试);`pbrVolumetricFogIntegration`/`pbrTransparencyPass`/`weightedOit` 测试;D:/Download `综合楼数字孪生.glb`(11KB,过小) | **无真实室内外场景** | 昼夜/玻璃/动态设备的固定场景缺失;GI 闭环验证(T02)需先建小而全的 S2 黄金场景 |
| S3 大装配(10 万/100 万/1000 万构件) | 冻结 manifest:`asset.bim.snowdon-towers-arch`(RVT 94.7MB,hash 已核验一致)、`asset.bim.bimface-demo-1`(6.5MB);`million_point_gpu_tests.rs`(1M 点,非构件) | **两档真实资产已冻结,无 10 万+ 构件档** | 千万构件资产与其显存压力版本缺失;三档(10万/100万/1000万)需按 manifest 合同补样本与分档记录 |
| S4 动画角色与机构(100/1000 角色) | glTF 蒙皮/变形测试族(`decodeSkinnedGlb`/`decodeMorphGlb`/`sparseDeformationAccessors`/`renderAnimationBridge`);机械臂:`workcell-validation-plugin/src/kinematics.ts`(FK/DLS-IK,commit `9f11df30`)、`urdfJointNormalization.test.ts`;`pbrDeformationShader.test.ts`(GPU 变形) | **单角色/机构有测试,无角色规模档** | 标准骨架/异比例骨架资产与 100/1000 角色阶梯场景缺失 |
| S5 物理导航(堆叠/薄墙/坡道/窄门/多代理) | `compileScenePhysicsRuntime.test.ts`、`rapierPhysicsJoint/CollisionEvents/DebugView/DebugOverlay`、`rapierCharacterController`、`roadPrefabPhysics`;Native `native_physics.rs`(4 内联测试)、`runtime_navigation_tests.rs` | **用例级覆盖,无黄金场景集** | 计划 T17 要求的堆叠/薄墙高速/铰链限位/机构驱动四组黄金案例未成 fixture;多代理导航场景缺失 |
| S6 环境与 VFX(固定 seed) | `fog/volumetricFog*` 测试族+`test:g7-volumetric-fog-gpu`;粒子 `gpuParticleRuntime/Emitters/BurstStage/IndirectDcir/pbrParticlePass` 测试;IES 光域网 fixtures(8 文件+golden);`modelFireEffect` 消费方;Native `million_point_gpu_tests.rs` | **算法级测试齐,无 seed 冻结的场景级对照** | 天气/水面/植被场景无;粒子发射统计的"相同 seed 可复现"验收缺 fixture(T20 项) |
| S7 2D 与文本(10 万行/复杂文字) | Native `deep2d_*` 测试族(含 vertex_transfer 预算/时序 GPU 测试、text_gpu、clip)、`text_raster_gpu_tests.rs`、`virtual_list.rs`(native_ui)、`retainedUi.test.ts`+预算合同(RETAINED_UI_BUDGETS)、`virtualSceneRows.test.tsx`(10000 行窗口化)、dashboard/glyph 族 | **虚拟列表 1 万行已测,10 万行与混排 golden 缺** | 阿拉伯文/中英混排 golden、10 万行实际挂载量证据缺失(T21 项) |
| S8 工业真值(有来源 CAD/BIM+独立验证) | `data/external-assets/industrial-format-plan/`(corpus-manifest.json:JT/X_T/RVT/E57-LAZ/3D Tiles/3DM/SLDPRT 七方向,逐工件 SHA-256+许可);X_T 语料 10 条 SHA256SUMS;plant-lite `golden/goldenPlant.test.ts`(seed 确定性指纹)、golden-07 碰撞/golden-08 联锁/golden-09 数字线程(`1251bd76`) | **七方向语料+仿真 golden 已冻结,是八类中最完备** | 独立验证数据(非自造真值)仍缺;RVT 为不可再分发(仅本地),可入库档位低 |

总结论:**S8、S1(协议层)可直接支撑 T22/T11 开工;S2/S3(重载档)/S4(规模档)/S5(黄金案例集)/S6(场景级)/S7(10 万行+混排)存在真实样本缺口**,均为对应工作包的首个子任务,不在 T00 内补建。

## 5. 样本清单(来源 / SHA-256 / 授权边界)

格式按 `benchmarkAssetManifest` 合同(source.path/bytes/sha256/format + license.redistributable/evidence)。

### 5.1 已冻结(仓内合同 fixtures)

| 样本 | 位置 | SHA-256 / 锚 | 授权边界 |
|---|---|---|---|
| asset.bim.snowdon-towers-arch(Snowdon Towers Sample Architectural.rvt,94,691,328 B) | `D:/Download/Snowdon Towers Sample Architectural.rvt`;manifest `packages/deep-engine/fixtures/benchmark-assets/manifests-v1.json` | `33271010919acb2a0d0d040851393a511d86ea7fd9a1f4c054797ae03e5e44a1`(本次实测=manifest 冻结值) | Autodesk 示例内容,**不可再分发**,仅本地基准 |
| asset.bim.bimface-demo-1(BIMFACE示例模型.rvt,6,459,392 B) | `D:/Download/BIMFACE示例模型.rvt`;同上 manifest | `8087a360173edaedf6d35992a8bbe7d4dc1904843024cec8f7d607cac73725fe`(实测=冻结值) | 广联达示例,**不可再分发**,仅本地基准 |
| 七方向格式语料(JT/X_T/RVT/E57-LAS-LAZ-COPC/3D Tiles/3DM/SLDPRT) | `data/external-assets/industrial-format-plan/`(不入 git) | `corpus-manifest.json` 逐工件;`*-SHA256SUMS.txt` 7 份(共 463 行)解包复算 | 依赖 MIT/Apache-2.0 可随包;样本各自许可见 manifest `licenseSPDX`/`licenseNotes`;X_T 语料上游明示不捆绑 Siemens schema/专有文件 |
| 基准轨迹 fixtures-v1(8 条,asset-bounding-sphere 归一化) | `packages/deep-engine/fixtures/benchmark-assets/trajectories-v1.json` | 由 `benchmarkAssetTrajectory` 合同逐字节校验 | 仓内自有 |
| IES 光域网(8 文件)+e02 golden | `packages/deep-engine/fixtures/ies/` | e02-golden.json 数值锚 | 仓内自有 |

### 5.2 本次新增登记(D:/Download,本地验证用,未入库)

| 样本 | SHA-256 | bytes | 拟映射 | 授权边界 |
|---|---|---|---|---|
| 50300电芯数模.stp | `13941ad4b9653cf10b1a3f03a0c9da368c5120b445515f07a4cf8cae61f67d4f` | 8,854,605 | S8/T22 STEP 档 | 来源不明(历史下载),仅本地验证,不入库 |
| 储能314Ah电芯数模.stp | `e162d4394b880640a4ddb05bfb11b381fb62058964851ac71d6008389467332e` | 2,678,784 | S8/T22 | 同上 |
| 41B5C5-PROFILE-20260407.stp | `c0e19e26cb5b3545aedff4b50e8ad9002bd6a2df6c5abd2d81a6eb8a6c76d494` | 172,032 | S8/T22 | 同上 |
| DamagedHelmet.glb | `a1e3b04de97b11de564ce6e53b95f02954a297f0008183ac63a4f5974f6b32d8` | 3,773,916 | S2/T08 材质球(Khronos glTF-Sample-Models,CC0 可入库) | CC0,可入仓 |
| 电芯.glb | `5eb8d59f57f6d2f5254963af026daa25f093b48c13c23bf10c0ef2ee7eb12371` | 20,113,932 | S1 车间构件候选 | 来源不明,仅本地 |
| 设备安装板.glb | `3bebb36e5fcd5ef9fa65cea071cbd1f867dbd802ae9e7eec0dbf829c5c40dedd` | 49,868 | S1 | 来源不明,仅本地 |

### 5.3 运行时样本(本次冻结)

| 样本 | SHA-256 | bytes | 说明 |
|---|---|---|---|
| S1 场景文档「678-副本」JSON | `58fa40d7f99a001ce81f2977768f7f9e6ab0dbc2da76b890582d57d2aeeedf03` | 15,248 | `test-output/deep-core/T00/s1-scene-frozen.json`;dev 数据库内容,不随 git 漂移保护 |
| S1 场景几何 geometry.glb | `7d646315a20d47ec4484626efbed17c6a018c4e3da1ef7d3f15fc9d35c9656dc` | 5,116 | `data/projects/38ea81ba-…/models/0db15819-…/output/geometry.glb`(源文件字节相同) |

## 6. 122 项处置与已完成证据登记(计划 §1 表 + 已完成证据链接列)

证据等级:**A=直接**(可运行测试或实测报告直接覆盖该子项);**B=间接**(底座模块/相邻测试存在,子项闭环未证);**C=未测**(无直接证据,unmeasured)。处置/工作包沿用计划 §1;排除项不要求证据。commit 均可 `git show <hash>` 验证。

### A. 渲染(T01–T10)

| # | 处置/WP | 正例指针 | 边界/失败例指针 | 关键证据 | 级 |
|---|---|---|---|---|---|
| 1 | 裁剪/T01 | `webgpu/adaptiveQuality.test.ts`、`adaptiveQualityRuntime.test.ts` | `resourceAdmission.test.ts`(超限拒绝) | `407bd8d8` 质量档批次;residencyDiagnostics | B |
| 2 | 保留/T02 | `lighting/probeSurfaceCache.test.ts`、`probeClipmapUpdateScheduler.test.ts`、`probeRelocationResolver.test.ts` | `probeRelocation.test.ts`(墙内探针搬迁) | `407bd8d8` probe GI shaders+tests;`test:probe-radiance-gpu` 入口;producer 复用 `probeOcclusionDirection`(反例整改已落) | B |
| 3 | 保留/T03 | `rayTracing/ssrRayExtension.test.ts`、`postprocess/screenSpaceReflectionPass.test.ts` | `screenSpaceReflection.test.ts`(边界) | 无跨端回退闭环实测 | B |
| 4 | 保留/T04 | `lighting/worldLights.test.ts`、`lighting/importanceBudget.test.ts`、`webgpu/localSpotShadowRuntime.test.ts` | `sharedShadowAtlasResources.test.ts`(资源冲突) | Native `shadow_map_tests.rs`/`shadow_dirty_tests.rs`/`cascaded_shadow.rs`;64/256/1024 灯阶梯未测 | B |
| 5 | 保留/T04 | `webgpu/pbrShadowState.test.ts`、`packetShadowLodResources.test.ts` | `pbrShadowSwitch.test.ts`(切换边界) | `shadow_fit_gpu_tests.rs` | B |
| 6 | 保留/T10 | `rayTracingCapability.test.ts`、Native `ray_tracing_capability.rs`、`hardware_ray_query.rs` | adapter_n1 fail-closed 族 | 能力探测≠渲染交付(计划明示) | B |
| 7 | 保留/T10 | `rayTracing/rayTrace*.test.ts`(7 个)、`bvhBuilder.test.ts`、`tlas.test.ts` | `rayTraceLayout.test.ts`(布局校验) | `test:ray-trace-gpu` 入口;收敛曲线未测 | B |
| 8 | 保留/T05 | `geometry/meshletBuilder.test.ts`、`virtualGeometryPages` 族、`webgpu/hiZOcclusionCulling` 族 | `previousHiZVisibility.test.ts` | `test:cluster-lod-gpu`/`clusterLod*` 7 测试;1 万实例提交 P95 基线未建(依赖 S1 重载场景) | B |
| 9 | 保留/T06 | `webgpu/pbrResidencyStream.test.ts`、`packetResidencyWorkingSet.test.ts`、`gpuTextureResidencyUploader` 族 | `pbrTransientTextureBudget.test.ts`(预算超限) | 页表/feedback 未证 | B |
| 10 | 保留/T07 | `postprocess/temporalAa.test.ts`、`temporalValidity.test.ts`、`temporalAaBilinear.test.ts` | `temporalAaSilhouette.audit.test.ts` | 残影能量 3 帧<5% 未测 | B |
| 11 | 保留/T08 | `webgpu/pbrShader.test.ts`、`pbrAuthorColorBindings.test.ts`、shaderGraph 族 | `gltf/textureEncodingAsset.test.ts`(色彩标记) | clearcoat/透射/SSS 未实现 | B |
| 12 | 保留/T09 | `fog/volumetricFog*.test.ts`(5 个)、`pbrVolumetricFogIntegration.test.ts`、`prefilteredEnvironment.test.ts` | `pbrEnvironmentSource.test.ts`(环境源回退) | `test:g7-volumetric-fog-gpu`;水/云/天气无 | B |
| 13 | 裁剪/T08 | `pbrColorGrading.test.ts`、`pbrDisplayColor.test.ts`、`author_grading.rs` | `pbrDirectDisplay.test.ts` | ACES/sRGB 已有;HDR 设备排除 | A(裁剪域) |
| 14 | 裁剪/T00/T01 | `webgpu/performanceTelemetry.test.ts`、`r12/frameCapture.test.ts`、`telemetry*_tests.rs` | `telemetry_sample_window_tests.rs` | 本报告第 2 节即诊断证据产出 | A |

### B. 场景与资产(T05/T11/T12/T13)

| # | 处置/WP | 正例指针 | 边界/失败例指针 | 关键证据 | 级 |
|---|---|---|---|---|---|
| 15 | 保留/T11 | `webgpu/sceneChunkResidency.integration.test.ts`、`sceneChunkFrameStage.test.ts`、`worldStreamingBridge` 族 | `sceneChunkResidency.lifecycle.test.ts`(失效) | Native `world_partition.rs`/`worldChunkBridge.test.ts`;HLOD 无 | B |
| 16 | 保留/T11/T12 | `pbrTransientTextureBudget.test.ts`、`assetBakeResidency.test.ts` | `resourceAdmission.test.ts` | 每设备预算闭环未证 | B |
| 17 | 保留/T12 | `assetReimportCoordinator.test.ts`、`assetReimport.test.ts` | 幂等/断链用例在协调器测试内 | `AssetReimportCoordinator` 底座;长期生产验证未测 | B |
| 20 | 裁剪/T13 | — | — | 地形/植被无模块(grep 仅命中无关文件) | C |
| 21 | 裁剪/T13 | `apps/web/src/prefabs/linearPrefabPath.test.ts`(工业参数化) | — | 通用 PCG 排除 | B(裁剪域) |
| 22 | 裁剪/T12 | `gltf/generatedNormals.test.ts`、`topologySpatialGeometry.test.ts` | `gpuValidatedStage.test.ts`(校验拒绝) | UV/简化/LOD 生成切片未建 | B |
| 23 | 裁剪/T12 | `assetPackage*.test.ts` 族、`assetCompatibility.test.ts` | `packagePurity.test.ts` | 跨项目引用影响分析未证 | B |
| 24 | 保留/T11/T05 | 本报告 §2 实测(切后端首帧 4.6–5.0s 冷 / WebGL 0.80s);`d0c9afc5`(指纹缓存+阶段 mark) | — | 整页冷启动仍未测(明示 unmeasured) | A |
| 25 | 保留/T05 | `gpu_occlusion_tests.rs`、`gpu_occlusion_consume_tests.rs`、`hiZOcclusionCulling` 族 | `visibilityBufferContract.test.ts` | 拾取/轮廓消费链核验是 T05 首项(计划首批清单 3) | B |
| 26 | 裁剪/T11 | `pbrRendererDisposal.test.ts`、`resourceCleanup.test.ts` | — | device lost/OOM 矩阵未测 | B |

### C. 动画角色(T14/T15/T16)

| # | 处置/WP | 正例指针 | 边界/失败例指针 | 关键证据 | 级 |
|---|---|---|---|---|---|
| 27 | 保留/T14 | `animation/SceneAnimationMixer.test.ts`、`stateMachine.test.ts`、`sampling.test.ts` | 分层/fade 边界在混合器测试内 | glTF bridge 消费链(`renderAnimationBridge.test.ts`) | A |
| 28 | 保留/T14 | `gltf/decodeSkinnedGlb.test.ts`、`decodeAnimatedGlb.test.ts`、`decodeMorphGlb.test.ts` | `gltf/accessorSparse.test.ts`(稀疏/异常) | `sparseDeformationAccessors.test.ts` | A |
| 29 | 保留/T15 | `apps/web/src/viewer/ik.test.ts` | 不可达/限位用例待补 | 计划明示"不能写成不存在";全身 IK 缺 | A(局部) |
| 30 | 保留/T15 | — | — | 跨比例重定向无 | C |
| 31 | 保留/T15 | — | — | Motion Matching 无 | C |
| 32 | 裁剪/T15 | — | — | Control Rig 编辑器排除 | C(裁剪域) |
| 33 | 保留/T16 | `apps/web/src/viewer/characterMotion.test.ts` | `rapierCharacterController.test.ts`(碰撞边界) | root motion/坡度台阶跨端未证 | B |
| 34 | 裁剪/T08/T16/T18 | `morph/runtime.test.ts` | `deformation/poseValidation.test.ts` | 面捕/口型排除;morph 形变底座在 | B(裁剪域) |
| 35 | 裁剪/T14/T16 | `cameraFraming.test.ts`、`cameraFramingIntegration.test.ts`、`deepCameraController.test.ts`、`runtime-camera-v1/v2.json` fixtures | — | 多镜头混合/避障缺 | B(裁剪域) |
| 36 | 裁剪/T14/T16 | `viewer/timeline.test.ts`、`loadingTimeline.test.ts`、`SceneTimelinePanel.tsx` | — | Sequencer 级多轨排除 | B(裁剪域) |
| 37 | 保留/T14 | `pbrDeformationShader.test.ts`、Native `native_animation_controller.rs`(tests 模块) | — | 100/1000 角色阶梯未测 | B |
| 38 | 保留/T14 | `gltf/runtimeDecodeTelemetry.test.ts` | `deformation/validation.test.ts` | 压缩/版本迁移工作流未证 | B |

### D. 物理导航仿真(T14–T19/T23)

| # | 处置/WP | 正例指针 | 边界/失败例指针 | 关键证据 | 级 |
|---|---|---|---|---|---|
| 39 | 保留/T17 | `compileScenePhysicsRuntime.test.ts`、Native `native_physics.rs`(4 内联 #[test]) | 材质/休眠用例待补 | Web Rapier+Native 双路径;跨端容差矩阵未建 | A(局部) |
| 40 | 保留/T17/T12 | `roadPrefabPhysics.test.ts`(预制体碰撞) | — | CAD→collider 生产链未建 | B |
| 41 | 保留/T17 | `rapierPhysicsJoint.test.ts` | `rapierPhysicsDebugView.test.ts`(调试可见性) | 马达/极限大规模验证未测 | A(局部) |
| 42 | 保留/T17 | — | — | CCD 极端速度回归矩阵未测 | C |
| 43 | 保留/T18 | `deformation/`+`morph/`(底座) | `deformation/validation.test.ts` | 布料/毛发/软体/破碎无 | B(底座) |
| 44 | 保留/T18 | — | — | 车辆物理无 | C |
| 45 | 保留/T19 | Native `runtime_navigation_tests.rs` | — | 坡度/步高闭环证据未公开 | A(Native 局部) |
| 46 | 保留/T19 | `transportNetwork.test.ts`(AGV 网络,plant-lite) | — | 多代理局部避障无 | B |
| 47 | 保留/T19/T23 | `goldenPlant.test.ts`(同 seed 同指纹确定性层)+`plantLitePortCrossBoundary.test.ts`(worker 内字节等值指纹,`1251bd76`) | `enginePort` SimulationPortError(空模型) | 跨端固定步长语义已测 | A |
| 48 | 保留/T19 | `perf/bench.test.ts`(有未提交改动,见 §1.1)、`45e5f7da`(16.5× DES) | — | 通用 ECS 排除;实体阶梯未测 | B |
| 49 | 保留/T23 | golden-07 碰撞/08 联锁/09 数字线程(`1251bd76`:goldenCollision/goldenInterlock/changePropagation) | fault-injected 失败用例(08 内) | 真实设备数据校准未测 | A(合成真值) |

### E. VFX(T20;音频视频影视 53–59 排除)

| # | 处置/WP | 正例指针 | 边界/失败例指针 | 关键证据 | 级 |
|---|---|---|---|---|---|
| 50 | 裁剪/T20 | `gpuParticleRuntime.test.ts`、`gpuParticleEmitters.test.ts`、`pbrParticlePass.test.ts` | `gpuParticleBurstTypes.test.ts`(burst 类型边界) | 事件/排序/灯光缺;seed 统计复现未测 | A(底座) |
| 51 | 裁剪/T20 | — | — | VFX 图排除 | C(裁剪域) |
| 52 | 裁剪/T20 | `modelFireEffect` 消费方 | — | 流体/烟无 | B(裁剪域) |
| 53–59 | 排除 | — | — | 音频底座 `dashboard_audio.rs` 存在但不入本计划 | — |

### G. 2D/UI(T21;80 排除)

| # | 处置/WP | 正例指针 | 边界/失败例指针 | 关键证据 | 级 |
|---|---|---|---|---|---|
| 74 | 裁剪/T21 | `deep2dDisplayList.test.ts`、`deep2dGoldenContract.test.ts`、Native `deep2d_*gpu_tests.rs`(12+ 文件) | `deep2d_path_clip_gpu_tests.rs`(裁剪边界) | Sprite/Tilemap/2D 骨骼/2D 物理缺 | A(既有域) |
| 75 | 裁剪/T21 | dashboard 命令/交互族(`dashboardFilterHitCommand/Runtime.test.ts`) | — | 手柄/HUD 动画缺 | B |
| 76 | 裁剪/T21 | `xrInput.test.ts`(浏览器输入面) | — | 统一动作资产/重绑定缺 | B |
| 77 | 裁剪/T21 | Native `text_raster_gpu_tests.rs`、`filter_glyph_gpu_tests.rs`、`dashboardGlyphRun.test.ts` | `deep2d-rich-text-ime-trace-v1.json`(IME trace fixture) | 复杂脚本/RTL golden 缺 | B |
| 78 | 裁剪/T21 | `SceneEnvironmentAccessibility.test.tsx` | — | 读屏/键盘全链未证 | B |
| 79 | 裁剪/T21 | — | — | 移动矩阵排除(仅现有浏览器触摸) | C(裁剪域) |
| 81 | 保留/T21 | `retainedUi.test.ts`+RETAINED_UI_BUDGETS 合同、Native `virtual_list.rs`、`deep2d_vertex_transfer_gpu_budget/timing_tests.rs` | `virtualSceneRows.test.tsx`(1 万行窗口化断言) | 10 万行挂载量证据缺 | A(1 万行档) |

### J/K. 工业与性能(T22/T23/T00/T05/T11/T12)

| # | 处置/WP | 正例指针 | 边界/失败例指针 | 关键证据 | 级 |
|---|---|---|---|---|---|
| 103 | 保留/T22 | `contracts/modelFormatCapability` 族、`formatImportContracts.test.ts`、`apps/api/src/industrialFormatProbe.test.ts` | `industrialFormatWaitingAcceptance.test.ts`(阻断态) | `3a64f10a` JT/X_T 质量报告+通用 X_T 解析器;`416f8508` X_T fallback 档/X_B 阻断 | A |
| 104 | 保留/T22 | `xtGenericConverter.test.ts`、`jtGlbConverter.test.ts`、parasolid-kit corpus expected JSON(数值锚) | `xtGenericFallback.test.ts`(fallback 边界) | 装配/布尔跨格式公差统计未建 | A(解析层) |
| 105 | 保留/T22 | `jtMaterialResolution.test.ts`、`jtOccurrenceAcceptance.test.ts`、`93b0e0a6`(类库属性继承) | — | 端到端保真率统计未建 | A(局部) |
| 106 | 保留/T22/T12 | `assetReimportCoordinator.test.ts` | — | 源版本差异/稳定 ID 冲突矩阵未测 | B |
| 107 | 保留/T22 | `topologyViewportGeometry.test.ts`、`player_picking*_tests.rs` | — | 千万构件交互 P95 未测(依赖 S3) | B |
| 108 | 裁剪/T23 | `dataWriteback.test.ts`、`directBinding.test.ts`(本地数据面) | — | PLM/SCADA/OPC UA 连接排除(`df4b376f` Live 模式属排除域,仅记录存在) | B(裁剪域) |
| 109 | 保留/T22 | `sceneBindingValidation.test.ts`、`109 空间语义`:floors/工程分析在场景合同(scene.json `floors`/`engineeringAnalysis` 字段) | — | 标准模型规范未公开 | B |
| 110 | 保留/T23 | `goldenPlant.test.ts`(golden01–05)+experimentAnalysis(`f7d2e3a1` LHS/CRN/Welch)+`74e363d5` RPW+`64046086` 多机器人联锁+`a6cbe32f` 瓶颈判据 | 限值/失败注入用例(golden 内) | 真实现场校准与置信区间实测未做 | A(合成验证集) |
| 111 | 裁剪/T23 | `trace.ts`/`studyReport.test.ts`(回放谱系) | — | 工单/远程控制排除 | B(裁剪域) |
| 112 | 约束/T22 | corpus-manifest 的 licenseSPDX 全列+`license-supplements/` | self-made-negative 目录(负样本) | 离线内置路线约束已实体化在语料治理中 | A |
| 113 | 保留/T00/T05/T11 | 本报告 §2(三后端配对);`benchmarkWindowComparison.test.ts`、`competitiveBenchmark.test.ts`、`benchmarkTargetMatrix.test.ts` | `benchmarkReadiness.test.ts`(未就绪态) | 跨引擎(Unity/UE)同素材对照未做且明确不作承诺 | A(内部配对) |
| 114 | 保留/T00/T05/T11 | 本报告 §2.1/§2.2;`7bae5c2b`/`4ec3c55f`(长任务归因探针) | — | HEAD 复测输入 P95 20.8ms 与 14.0ms 差异待归因(T11 首项) | A |
| 115 | 保留/T11 | `benchmarkSampleSchema` 合同(memory 通道+availability=unavailable 语义) | — | 峰值/碎片/抖动可视化 unmeasured(fair-comparison heapUsedMb=0 未接通) | C(运行时) |
| 116 | 裁剪/T00/T11/T12 | `d0c9afc5`(packet 编译缓存,阶段计时) | — | 全流程计时(导入/shader 编译)未测 | B |
| 117 | 裁剪/T00 | `gate:deep-p0:browser/native/studio`、`modelFormatCapability` 三态 | — | 公开绿黄红矩阵未发布 | A(门禁存在)/C(公开矩阵) |
| 118 | 保留/T00+ | `renderImageSimilarity.mjs`(SSIM/MAE)+对照脚本确定性守卫(本报告 r1 位姿 SSIM=1.0)+`render-engine-comparison` 差异图输出 | 差异热图仅 partial-pbr-shadow-only | 跨 GPU/驱动矩阵未测 | A(单机)/C(矩阵) |
| 119 | 保留/T00+ | S8 语料+本报告 §5 清单 | — | 长周期企业场景回归未建 | B |
| 120 | 裁剪/T00/T11 | fair-comparison guards(pageerror/http5xx 捕获,r3–r6 实证捕获 502 楔死) | — | 版本回归归因统计未建 | A(捕获)/C(归因) |

排除项(不要求证据):18、19、53–59、60–73、80、82–102、121、122,共 47 项。

### 覆盖统计(按 §6 逐行计数)

| 证据等级 | 项数 | 占 122 比例 | 说明 |
|---|---|---|---|
| A 直接(含"裁剪域内已有"与"局部直接") | 24 | 19.7% | 有可运行测试或本次实测直接覆盖该子项 |
| B 间接(底座/相邻测试,闭环未证) | 42 | 34.4% | 模块与测试存在,子项验收未达成 |
| C 未测(unmeasured) | 9 | 7.4% | 编号 20、30、31、32、42、44、51、79、115(其中 20/32/51/79 为裁剪域,115 为运行时内存通道) |
| 排除(不计证据) | 47 | 38.5% | 计划 §1 明确排除 |

分项来源:A:区域 A×2(13/14)、B×1(24)、C×3(27/28/29)、D×5(39/41/45/47/49)、E×1(50)、G×2(74/81)、J/K×10(103/104/105/110/112/113/114/117/118/120);B:区域 A×12、B×8、C×6、D×4、E×1、G×4、J/K×7;C:见上表。合计 75(保留/裁剪)+47(排除)=122。

注:个别项同时含两态(如 117 门禁存在/公开矩阵缺、118 单机 SSIM/跨 GPU 矩阵缺、120 捕获/归因)按其主要已证面计入 A,未证面在行内注明;未测项一律记 unmeasured,未填零。保留/裁剪 75 项中,A+B=66/75(88.0%);保留域纯 unmeasured 5 项(30 重定向、31 Motion Matching、42 CCD、44 车辆、115 内存通道)。

## 7. T00 验收对照(计划卡)

| 验收条 | 状态 | 证据 |
|---|---|---|
| 每个保留工作包至少一个可运行正例+失败/边界例指针 | **partial** | 22 个保留 WP 中 19 个有指针(§6 各表);T13(地形/植被)、T15 的重定向/Motion Matching 子域、T18 全部五子域、T20 的流体/烟子域**无实现也无测试指针**——这是真实缺口,不能由 T00 凭空补,已标 C 并列为对应 WP 首子任务 |
| CPU/GPU/输入/内存缺失计 unmeasured 不填零 | 满足 | §2.1 GPU complete null、§1.1 电源 unmeasured、§6 C 级各行 |
| 至少三次独立运行 | 满足(有保留意见) | r1/r2 干净通过 + r7 通过但环境污染已声明;r3–r6 失败台账公开(§2.3) |
| 环境与采样口径可复现 | 满足 | §1 环境+协议;run 目录含 report.json(内嵌 gitHead/协议/守卫) |
| 新测与旧结果分别存档 | 满足 | 旧:`test-output/deep-fair-comparison-*`、`render-engine-comparison` 未动;新:`test-output/deep-core/T00/` |
| 场景 manifest 冻结(§6.1) | **partial** | §4:S8/协议层已冻结;S1 重载/S2–S7 样本缺口逐项列出,归对应 WP |
| 至少一次当前 HEAD 实测 | 满足 | r1–r7 全部 @ `e616677a` |

## 8. 移交下一工作包的可执行动作

1. **T11**:①在**干净 checkout**(冻结并行会话改动)上做含/不含 `deepCameraInputSession.ts` 的输入 P95 A/B,归因 14.0→20.8ms;②首切/暖切双口径入验收;③修复 WASM 首帧 mark 残留与 dragSmoothness 采样;④fair-comparison 连跑 502 楔死需协议层重试或独立端口(dev 服务由脚本自管);⑤heap/memory 通道接通(当前 unmeasured)。
2. **T01/T02/T05/T10**:开工首步各跑一个 GPU 脚本(`test:probe-radiance-gpu` 等)取当前 HEAD 的 GPU 通道证据,本报告未代跑。
3. **T22**:恢复 `docs/specs/industrial-3d-format-work-plan-2026-09-16.md` 权威文件(路径仍缺失);语料与哈希已就绪可先做 profile×样本矩阵。
4. **T00 后续补档**:S1 万实例场景生成、S5 黄金物理案例 fixture 化、统一 seed 登记表——不阻塞 W1 开工。
