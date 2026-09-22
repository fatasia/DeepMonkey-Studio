# 引擎能力扩展任务计划（2026-09-22 用户指令）

> 本文件是 `docs/handoffs/deep-monkey-remaining-work-handoff-2026-09-22.md` 的增补。
> 用户指令：A1–A5、B6、B1、B2、B3 全部加入后续一阶段任务；B1 补足到完整、B2/B3 走优化方案。
> **强制纪律（用户 2026-09-22 明确要求）**：做任何任务前必须做现状核查，禁止重复建设；
> 性能必须优化到极致。

---

## 0. 现状核查前置纪律（强制，违反视为缺陷）

每次开工前，按序完成并在本文档追加核查小节：

1. **grep 全仓**：任务关键词在 `packages/*/src`、`apps/*/src` 的命中（含未跟踪文件 `git status --short | grep '^??'`）。
2. **读契约层**：`packages/contracts/src/*.ts` 与 `packages/deep-engine/src/**/types.ts` 是否已有该能力的类型定义。
3. **查依赖**：`package.json` / `Cargo.toml` 是否已有库（例：物理已有 `@dimforge/rapier3d-compat` 与 `rapier3d`）。
4. **找消费方**：`grep` 该 API 的调用点——有消费方说明能力已在用，只能补缺口。
5. **查测试与证据**：`*.test.ts(x)`、`tests/*.rs`、`docs/reports/`、`test-output/` 是否已有该能力的证据。
6. **查规格文档**：`docs/specs/`、`docs/reports/`、`docs/active-task-recovery-ledger.md` 的既有结论。
7. 核查结论写入本文档对应任务的"现状核查"小节，**写明"已有（不重建）"与"真实缺口"**，然后才动手。

**已犯错误记录（作为反例，禁止复发）**：
- 设计 F1 方向集时未先查仓库已有 `probeOcclusionRayExtension.probeOcclusionDirection`，重复实现方向公式并引入合同漂移缺陷（已在 `7c454be` 修正）。
- 评估 B3 物理工作量时未先查 `compileScenePhysicsRuntime.ts`、`native_physics.rs`、`physics-validate/` crate，把已有 70% 的能力当成从零建设。
- 评估 B2 序列器时未先查 `SceneTimelinePanel`（502 行）、`viewer/timeline.ts`、`sceneAnimationStateMachineRuntime.ts`，低估既有能力。

---

## 1. 渲染管线类（A 组）

### A1. 虚拟几何（Nanite 级 GPU-driven 全量几何）

**现状核查（2026-09-22）**：已有 `packages/deep-engine/src/rayTracing/clusterLod*`（clusterLodDag / clusterLodSelection / clusterLodBake）、`webgpu/pbrLodWork.ts`、`gpu_lod.rs`（Native）、分页虚拟几何 CPU demand/residency（台账 2026-09-20 记录"分页虚拟几何 CPU demand/residency"已收口，GPU feedback 仍缺）。**已有的是 LOD 选择与分页驻留，不是 GPU-driven 无索引全量几何。**

**缺口**：① 集群（cluster）切分与 DAG 构建的离线烘焙产物；② GPU 端 cluster 剔除与间接绘制；③ 软件光栅化微三角形（当前 `softRasterizeFallback` 是可见性缓冲回退，非 Nanite 级微多边形）；④ GPU feedback 驱动的按需流送（CPU 版已有）。

**价值**：极高。决定十亿面级 BIM/倾斜摄影模型能否进浏览器与 Native，是"大模型"战场的门票。

**工作量**：20–30 天（集群烘焙 5–8 天 / GPU 剔除与间接绘制 5–8 天 / 微多边形光栅 6–10 天 / GPU feedback 流送 4–6 天）。

**性能要求**：集群剔除必须在 GPU 完成（CPU 端每帧遍历 cluster 会成为瓶颈）；间接绘制单帧 draw call ≤ 集群页数；目标：1 亿面模型在 1080p 下 ≥60fps（RTX 3060 级）。

---

### A2. Lumen 级动态 GI

**现状核查（2026-09-22，二次核查修正）**：F1 已交付探针一跳场景辐射（`probeSceneRadianceProducer`）+ 环境均值读回 + 能量钳制 + 受限历史反馈 + 产品宿主接线，真机 gate TRUE。**二次核查发现：三线性插值已实现**（`lighting/probeClipmapTextureSamplingWgsl.ts` 的 `deepGiTextureLevelSample` 做双线性 xy + 双 z 层 mix；`deepGiSampleTexture` 再做层级混合与边界 blend；`probeClipmapSampling.ts` 有 CPU 对应实现与测试）。此前本文档写的"DDGI 三线性待做"是误判——**禁止重建**。

**真实缺口**：① **泄漏抑制**（DDGI 法线权重未实现：当前用 `textureSampleLevel` 做双线性，无法对 8 个探针分别施加法线权重；标准 DDGI 需手动 8-tap + `pow(max(dot(probeDir, normal), 0), bias)` 权重）；② 屏幕空间 GI（SSGI）通道；③ RT GI 与探针的混合策略；④ 多灯体积时域（台账已列待办）。

**价值**：极高。泄漏抑制是 DDGI 画质的关键——室外光漏进室内、亮区漏到暗区是最明显的伪影；SSGI 决定室内细节光照。

**工作量**：泄漏抑制（8-tap 法线权重 + Chebyshev 反向检测）3–5 天 / SSGI 5–8 天 / RT GI 混合 3–5 天 / 多灯时域 2–4 天。

**性能要求**：8-tap 手动采样取代单次双线性会增采样开销，必须实测（目标：GI 采样 ≤ 帧时间 15%）；探针更新在 GPU 内闭环，不引入 CPU 读回同步点。

---

### A3. 硬件 RT 主路径

**现状核查（2026-09-22）**：Native `hardware_ray_query.rs` 已真机验证 BLAS/TLAS 构建与 Ray Query 命中回读；F2 驻留切片（`renderer/rt_residency.rs`，10/10 测试）已交付 BLAS 缓存 + 场景 TLAS + frame AccelerationStructure 槽；`player_diagnostics` 诚实标记 `tlas_resident_pixel_pending`。**已有的是驻留与绑定，不是像素消费。** Web 端 RT 走软件 BVH（`rayTracing/*`），因 WebGPU 无 RT 扩展。

**缺口**：① fragment shader 内的 Ray Query 阴影（Native）；② 静态反射；③ RT 探针遮挡/GI；④ Web 端无硬件 RT 的现状（需等 WebGPU 标准化，或保持软件 BVH）。

**价值**：高。Native 端画质上限；Web 端受平台限制。

**工作量**：Native 阴影 5–8 天 / 反射 4–6 天 / GI 3–5 天；Web 端等平台（不做）。

**性能要求**：RT 阴影仅在能力可用时启用并 fail-closed 回退栅格；TLAS 更新走 transform-only（已具备）。

---

### A4. SDF / 体积雾 / 流体 / 粒子

**现状核查（2026-09-22）**：已有体积雾（`volumetricFog` feature + `g7-volumetric-fog-gpu` 测试）、Bloom、SSR、AO、色阶后处理栈。**缺 SDF 场、流体、粒子系统。**

**缺口**：① 粒子系统（GPU 实例化 + 生命周期 + 发射器）；② SDF 场渲染（体积/表面）；③ 流体（可评估为不做，或只做屏幕空间近似）。

**价值**：中。氛围与特效；BIM 场景需求低于游戏。

**工作量**：粒子 3–5 天 / SDF 4–6 天 / 流体 8–12 天（建议先不做流体）。

**性能要求**：粒子全 GPU 驱动（CPU 只更新发射器参数），10 万粒子 ≤3ms。

---

### A5. GPU 蒙皮与 IK

**现状核查（2026-09-22）**：已有 `deformation` 支持（`deformationPipelines`、`DeformationSnapshot`、`DeformationPose`）、`animationRuntimeProbe`、Native 侧 deformation 编码路径。**需核查是否已是 GPU 蒙皮还是 CPU 变形。**

**缺口**：① GPU 蒙皮（骨骼矩阵调色板 + 顶点着色器蒙皮）；② IK 求解器（BIM 需求低，可选）。

**价值**：中低（BIM 场景），但对机械动画/机器人有意义（仓库有 URDF 加载）。

**工作量**：GPU 蒙皮 5–10 天 / IK 5–8 天。

---

## 2. 工作流类（B 组）

### B1. 脚本编辑器补足到完整

**现状核查（2026-09-22，已实测）**：底座远超预估——Monaco 编辑器（`ProfessionalCodeEditor.tsx` 347 行，含补全/悬停/Problems/类型注入）、Worker 沙箱（`sceneBehavior.worker.ts` 411 行，含源码黑名单/全局锁/动态 import 拒绝/依赖 SHA-256）、静态分析（`sceneScriptAnalysis.ts` 213 行）、运行日志控制台、DevTools 断点会话、依赖与版本管理 UI、大量单测。**已有的是完整可用的编辑器，不是雏形。**

**真实缺口（6 项）**：
1. 语言固定 JavaScript，无 TypeScript 类型检查（`checkJs: false`）。
2. 无产品内断点/单步/变量查看（依赖外部 DevTools）。
3. 无 `console.*` 捕获（只有 `ctx.log`），无日志级别 API。
4. 静态分析为纯正则，无 AST/作用域分析，部分问题固定报在 line 1。
5. 无编辑器内单元测试运行器、无热重载调试。
6. 沙箱自述非敌对代码安全边界（需 CSP/SES/QuickJS）。

**价值**：高。脚本是 BIM 数字孪生的核心扩展点，调试体验直接决定可用性。

**工作量**：① TS 类型检查 3–4 天（`checkJs` + 类型注入已有基础）；② 产品内断点 8–12 天（需 lineOffset 精确映射 + Worker 协议扩展 + 变量序列化）；③ console 捕获 + 日志级别 1–2 天；④ AST 分析 3–5 天（引入 es-module-lexer 已在，可加 acorn 或 TS compiler API）；⑤ 编辑器内测试运行器 4–6 天；⑥ 沙箱加固 5–10 天（QuickJS/SES）。

**性能要求**：Monaco 大文件（2MB 上限）不卡顿；静态分析 debounce ≤300ms；断点不显著降低脚本执行帧率。

---

### B2. 序列器/时间轴优化

**现状核查（2026-09-22，已实测）**：`SceneTimelinePanel.tsx` 502 行——相机 + 多对象轨道、关键帧增删移复制、Auto Key、播放控制（循环/往返/速度 0.25–4×/帧率 24–60/按帧吸附）、单帧 Inspector、片段状态机 UI、采样运行时（含 Catmull-Rom spline）、发布侧动态动画下译、10+ 测试文件。**已有的是可用的导演台，不是雏形。**

**真实缺口（7 项，按价值排序）**：
1. **属性轨道仅 transform/相机/clip 时间**——缺材质、可见性、透明度、灯光通道。
2. **缓动仅 5 个枚举预设**——无贝塞尔曲线编辑器与曲线视图。
3. **状态机不可图编辑**——状态/过渡由 clip 自动环形生成，参数仅 boolean 且每过渡仅一条件，无 AnyState/退出时间/多条件。
4. **无时间轴烘焙导出**——不能烘成 GLTF 动画或采样帧序列。
5. **发布下译丢失缓动语义**（`dynamicRuntimePlayback.ts` 纯线性 lerp），且对象片段动画被显式排除。
6. 无倒放 UI、无区间播放/循环区间、无标记点/事件轨。
7. Inspector 无撤销/重做绑定；无交互级组件测试。

**优化方案（分三期）**：

- **B2-a 语义补全（高价值，先做）**：属性轨道扩展（材质/可见性/透明度/灯光）+ 事件轨/标记点 + 区间播放 + 倒放 UI。约 5–8 天。
  性能：轨道采样走既有 `viewer/timeline.ts` 的二分查找，新增轨道不改变每帧 O(轨道数×活动帧) 复杂度。
- **B2-b 下译保真（中高价值）**：把 transition 缓动语义下译到 runtime（当前丢失），并让 Web 发布查看器消费对象片段动画。约 3–5 天。
  这修复的是"作者所见 ≠ 发布所得"的语义缺陷，优先级高于新功能。
- **B2-c 曲线与状态机（中价值）**：贝塞尔曲线编辑器 + 图编辑状态机（手工增删状态/边、多条件、AnyState）。约 8–12 天。

**性能要求**：500 帧 × 20 轨道的 scrub 必须 ≥60fps（标尺渲染需虚拟化）；关键帧拖拽无重排抖动。

---

### B3. 物理优化

**现状核查（2026-09-22，已实测）**：底座完整度最高——Web `@dimforge/rapier3d-compat 0.19.3` + Native `rapier3d 0.35.3`（enhanced-determinism），**独立 crate `physics-validate/` 已实测 240 步逐位一致**；`native_physics.rs` 438 行（事务式构建、CCD、render-bounds 碰撞体）；`physicsWorldHost.ts`（固定步长 1/60 + 追赶上限 0.2s）；旋转关节含 impulse/multibody 求解器、限位、速度马达；`ScenePhysicsPanel.tsx` 279 行 UI。**已有的是生产级物理，不是雏形。**

**真实缺口（9 项，按价值排序）**：
1. **碰撞体形状仅 AABB/OBB**——无 sphere/capsule/convex/mesh/复合。
2. **无 kinematic 刚体与角色控制器**（`PhysicsBodyType` 仅 none/fixed/dynamic）。
3. **关节仅 revolute**——无 fixed/prismatic/spherical/rope。
4. **重力仅暴露 Y 分量**；per-body 阻尼/CCD 开关硬编码。
5. **无物理调试可视化**（碰撞体线框/接触点/休眠）。
6. **无物理事件回调**（碰撞开始/结束）暴露给脚本/UI。
7. **Web 发布查看器不消费编译出的 physics 通道**——Web 与 Native 各跑一套，发布产物物理失效。
8. **物理与相机碰撞/picking 是两套系统**（后者走 mesh raycast）。
9. Native 无地面平面（Web 有 5000m 地面），跨端行为不一致。

**优化方案（分三期）**：

- **B3-a 跨端一致性（最高价值，先做）**：修复缺口 7（Web 发布查看器消费 physics runtime 通道）+ 缺口 9（Native 补静态地面）。这修复的是"发布后物理不生效"与"两端行为不一致"的真实缺陷。约 3–5 天。
- **B3-b 能力扩展（高价值）**：kinematic 刚体 + 角色控制器（缺口 2）、复合/凸包碰撞体（缺口 1）、关节扩展（缺口 3）。约 8–12 天。
- **B3-c 可观测性（中价值）**：物理调试可视化（缺口 5）+ 事件回调（缺口 6）+ per-body 参数（缺口 4）。约 5–7 天。

#### B3-b 切片（kinematic 刚体 + 角色控制器）现状核查（2026-09-22，本切片开工前实测）

按六步核查（关键词 `kinematic` / `CharacterController` / `character_controller`，范围 `packages/*/src`、`apps/*/src`，含未跟踪文件）：

1. **全仓 grep**：`kinematic` 仅命中机器人运动学（`RobotKinematicsControl.tsx`、`robotWorkcellCycleBudget.ts` 的 `kinematic-cycle-budget-v1`）与 rapier 依赖自身——**物理 kinematic 刚体零命中**；`CharacterController` / `character_controller` 在 `packages/*/src`、`apps/*/src` **零命中**。
2. **契约层**：`packages/contracts/src/scene.ts:45` `PhysicsBodyType = "none" | "fixed" | "dynamic"`（无 kinematic）；`ScenePhysicsBodyState` 只有 `type/mass/friction/restitution`，**无角色控制器字段**；`packages/deep-engine/src/runtimePackage/dynamicSceneRuntime.ts:57-59` `DynamicPhysicsBodyRuntime.type` 同为两值；`packages/contracts/src/sceneValidation.ts:382` `requiredLiteral(object, "type", ["none","fixed","dynamic"])` 是第三个 fail-closed 闸门。
3. **依赖**：Web `@dimforge/rapier3d-compat 0.19.3`（`apps/web/package.json:40`）、Native `rapier3d 0.35.3`（enhanced-determinism）。**两侧 API 均存在但未被使用**——实测 `apps/web` 内 `node -e` 调用确认 `world.createCharacterController(offset)`、`setMaxSlopeClimbAngle`、`enableAutostep`、`enableSnapToGround`、`computeColliderMovement`、`setApplyImpulsesToDynamicBodies`、`RigidBodyDesc.kinematicPositionBased`、`setNextKinematicTranslation`、`computedGrounded` 全部为 function；Native `rapier3d-0.35.3/src/control/character_controller.rs` 有 `KinematicCharacterController`（`pub up/offset/slide/autostep/max_slope_climb_angle/min_slope_slide_angle/snap_to_ground`、`move_shape`），**但未在 `prelude.rs` 重导出**，须走 `rapier3d::control::KinematicCharacterController` 全路径。
4. **消费方**：`viewerEngineSimulation.ts` 的 `createPhysicsBody` 只有 `dynamic()` / `fixed()` 二元分支；`native_physics.rs:162` 同样二元；`compileScenePhysicsRuntime.ts` 的 filter 仅放行 `fixed`/`dynamic` 且把 `state.type as "fixed" | "dynamic"` 硬转型。
5. **测试与证据**：Web 侧有 `physicsWorldHost.test.ts`、`rapierPhysicsJoint.test.ts`、`compileScenePhysicsRuntime.test.ts`、`ScenePhysicsPanel.test.tsx`；Native 侧 `native_physics.rs` 3 项、`dynamicSceneRuntime.test.ts` 有 v3 physics 用例；`physics-validate/` 240 步逐位对拍（F04–F07）。**kinematic / 角色控制器用例为零**。
6. **规格文档**：本文件 B3 节 + `docs/active-task-recovery-ledger.md` 2026-09-22 条目；`characterMotion.ts`（`slideAgainstSurface` / `isWalkableSurface`）是**相机漫游的自研碰撞**，走 mesh raycast，与 Rapier 角色控制器**不是同一系统**，本切片不改它（属缺口 8）。

**核查结论——已有（不重建）**：Rapier 双端生产级刚体/关节/碰撞体下译与确定性对拍链路完整；`PhysicsWorldHost` 固定步长时钟、`normalizePhysicsJoints` 归一化模式、`dynamic_scene_physics.rs` 的 fail-closed 校验与 `physics-validate` 场景 spec 单一来源纪律都可直接扩展。

**真实缺口（本切片）**：① 三处 `type` 枚举与三处消费分支都不认 kinematic；② 角色控制器在两端零实现、契约零字段；③ 无 kinematic / 角色控制器测试；④ 无 kinematic 步进开销实测。

**诚实边界（不在本切片伪造）**：Native 侧角色控制器虽有 `rapier3d` API，但 `native_physics.rs` 的渲染同步只回写 `dynamic` body（`sync_packet` 的 `if !binding.dynamic { continue }`），kinematic body 需要宿主显式调 `set_next_kinematic_translation` 才有运动；**本切片只让 Native 消费 kinematic 刚体（静态位姿、可被 dynamic 碰撞），角色控制器在 Native 侧明确记为 degraded 且不消费**，不假装已实现。

**性能要求**：物理步进固定 1/60 且不与渲染帧耦合（已有）；碰撞体形状升级后必须保持 16384 body 上限内的步进 ≤4ms；Native 与 Web 的逐位确定性必须由 `physics-validate` 扩展用例守住（新增形状/关节后必须补对拍）。

---

## 3. 任务排序与依赖

```text
A2 (Lumen 级 GI)     ← 依赖 F1 已完成；最高优先
A1 (虚拟几何)         ← 独立；最高优先
B3-a (物理跨端一致)   ← 修复真实缺陷；优先
B2-b (下译保真)       ← 修复真实缺陷；优先
B1-③④ (console/AST)  ← 低成本高收益；优先
A4 (粒子/SDF)  A5 (蒙皮)  B1 其余  B2-a/c  B3-b/c  A3 (RT 像素消费)
```

**共同纪律**：每个切片完成后必须更新本文件、`docs/active-task-recovery-ledger.md` 与相关 spec；每个切片必须有真机/实测证据，不接受"应该可以"。

---

## 4. Shader / WGSL 一等公民专项（新增，2026-09-22 用户指令）

### 4.1 现状核查（先于任何实现，已完成）

**仓内已有（禁止重复建设）**：

- `packages/deep-engine/src/shader/types.ts` 已有完整 Shader IR：`ShaderProperty`、`ShaderResourceBinding`、`ShaderNode`、`ShaderStageGraph`、`ShaderPass`、`ShaderTechnique`、`DeepShaderAsset`、`ShaderKeyword`、`ShaderVariantPlan`、`ShaderSourceMapEntry`、`ShaderCompileResult`、`ShaderCompilerDataLayout`。
- `packages/deep-engine/src/shader/compiler.ts` / `compilerAnalysis.ts` / `compilerWgsl.ts` 已有图排序、绑定收集、验证、WGSL 代码生成；`shader/variants.ts` 已有变体规划。
- `packages/deep-engine/src/shaderAuthoring/` 已有 DeepSL 文本前端、解析器、诊断、编译器、WGSL package adapter、PBR/Unlit/CSM/辅助 pass 适配；约 8,000 行（含测试）。
- `shaderPresets/` 已有 Standard Surface / Unlit 图预设；`webgpu/shaderPackageExecutor.ts` 已有 shader package 执行；`shaderAbi/` 已有多版本 ABI（V1–V4）。
- GPU/WGSL 是现有生产主路径：PBR shader、后处理、探针、粒子均为 WGSL 字符串 + WebGPU pipeline，不能再引入 GLSL-first 或第三方商业 shader compiler。

**真实缺口（不重建已有 compiler）**：

1. **无产品级可视化 Shader Graph 编辑器**：仅有 `PlantLiteNodeEditor`（非 shader graph）；没有节点画布、端口拖线、图缩放/框选/撤销、节点搜索。
2. **无稳定图资产序列化/版本迁移 UI**：现有 `DeepShaderAsset` 是引擎 IR，但没有作者侧 JSON 资产 schema、版本迁移、hash/依赖闭包 UI。
3. **节点注册与反射不完整**：编译器有 `ShaderNode` union，但没有类似 Babylon `BlockNodeData` / Unity NodeClassCache 的 editor metadata registry（displayName/category/ports/preview/target constraints）。
4. **无 Blackboard/Property Inspector**：`ShaderProperty` 合同存在，但缺作者侧属性面板、默认值/范围/材质实例覆盖、关键词 UI。
5. **无 SubGraph / reusable node library**：已有 preset graph 是代码构造，没有可嵌套、可复用、可版本化的作者子图。
6. **无 Target/SubTarget 图级约束与多 pass 选择 UI**：已有 `ShaderPass`/`ShaderTechnique`/capabilities 合同，但缺类似 Unity Target/SubTarget 的产品选择层；应复用既有 compiler capabilities。
7. **无节点级预览与错误定位**：已有 compiler diagnostics/source map，但没有节点/端口级错误回显、Naga/validation 输出绑定到图节点、隔离预览材质。
8. **无图资产的性能/变体预算可视化**：已有 variant plan、binding/layout、source map，缺编辑器中的 shader cost（节点数、纹理采样、varying、变体数、uniform/storage bytes）面板。

### 4.2 外部架构审计结论（只借鉴结构，不复制代码）

- **Babylon Node Editor/NME（Apache 2.0）**：源码中 `BlockNodeData` 把运行时 `NodeMaterialBlock` 映射为编辑器 node data；`ConnectionPointPortData` 统一端口方向、类型兼容性、连接/断开、错误消息；`GlobalState` 持有 NodeMaterial、预览和 build/error observable。其 `packages/tools/nodeEditor/src/graphSystem/` 可借鉴“运行时节点 ↔ 编辑器节点元数据适配层”和独立 Preview/Log 面板。Babylon 另有独立 node-editor、node-geometry-editor、node-particle-editor、node-render-graph-editor 包，说明材质/粒子/渲染图可共享 graph canvas 但保持领域 block registry。
- **Unity Shader Graph（Unity Graphics 仓库，ShaderGraph 包含独立 LICENSE.md）**：`Editor/Data/Graphs/GraphData.cs` 用 `JsonObject` + `JsonData<T>` 序列化 properties、keywords、dropdowns、categories、nodes，并维护 added/removed/moved 增量集合；`AbstractMaterialNode` 持有 `MaterialSlot`；`MultiJsonInternal` 用类型信息注册/恢复派生 JSON 对象。`Editor/Generation/Target.cs` 把 `IsActive/Setup/GetFields/GetActiveBlocks/GetPropertiesGUI/CollectShaderProperties/ProcessPreviewMaterial/IsNodeAllowedByTarget` 作为 Target 扩展点；`SubTarget.cs` 做管线/材质子目标分层。可借鉴 GraphData/Target/SubTarget/Slot/diagnostic 分层，不复制 C# 实现或序列化格式。
- **WGSL 结论**：Unity Shader Graph 源码与目录没有 WGSL/WebGPU backend 证据，不应把 Unity 的代码生成当 WGSL 方案；Babylon 的现有 NodeMaterial runtime/Node Editor 可参考 WebGPU 领域分层，但本仓库的 WGSL compiler 已有且应继续作为一等公民。

### 4.3 最小增量架构（性能优先，不重写 compiler）

**Phase S1：作者图合同 + registry（3–5 天）**

- 新增 `packages/deep-engine/src/shaderGraph/`（仅合同与纯逻辑，单文件 <300 行）：
  - `graphTypes.ts`：`ShaderGraphAssetV1`、`ShaderGraphNode`（引用既有 `ShaderNode`）、`ShaderGraphEdge`、`ShaderGraphProperty`、`ShaderGraphTarget`、`ShaderGraphDiagnostic`。
  - `nodeRegistry.ts`：节点元数据 registry（display/category/ports/type/target/preview），编译时把 graph asset lowering 到既有 `ShaderStageGraph`，**不新增第二个 compiler**。
  - `graphSerialization.ts`：canonical JSON、schema version、迁移、SHA-256 dependency/hash manifest。
  - `graphBudget.ts`：节点/边/采样/varying/variant/绑定预算，复用既有 compiler analysis。
- 测试：canonical determinism、版本迁移、未知节点 fail-closed、端口类型矩阵、预算边界、lowering 与既有 preset graph 字节/语义对拍。

**Phase S2：编辑器（5–8 天）**

- 复用现有 `PlantLiteNodeEditor` 的画布交互基础（先核查是否可泛化），新增 `ShaderGraphEditor`：节点/端口/拖线/搜索/框选/撤销；registry 驱动渲染，不把节点组件写死。
- Blackboard 复用 `ShaderGraphAssetV1.properties`，Inspector 写入单一资产入口；错误面板消费既有 source map + compiler diagnostics。
- 只做 Web 编辑器，不在 Native 重建 UI。

**Phase S3：预览/Target/SubGraph（5–8 天）**

- Preview：复用 `PbrRenderer`/离屏 frame capture，图变更增量 compile + debounce 300ms；失败保留上一个可用 shader（LKG），不黑屏。
- Target/SubTarget：只做已有生产 pass 的 target（PBR forward/depth/shadow/picking + unlit），把 `ShaderTargetRequirements`/`ShaderPass` 作为唯一权限来源；未知 capability 显式阻断。
- SubGraph：资产引用 + canonical dependency closure，不复制 node，编译前展开到既有 IR，循环依赖 fail-closed。

**性能硬指标**：

- 图编译 debounce ≤300ms；100 节点 lowering P95 ≤16ms（不含 GPU pipeline 编译）；变体数量超预算在编辑器阻断；只重编译受影响 pass；Preview 使用 LKG，不阻塞主渲染帧。
- 运行时不动态解析 JSON、不保留编辑器 node object；资产发布前 canonical hash + 依赖闭包，运行包使用已编译 WGSL/package。
