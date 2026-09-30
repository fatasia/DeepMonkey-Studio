# J2-B4 CSM/PCF 现状与下一刀

日期：2026-09-30。结论：三族零宽混合保护和非混合区提前返回的最小切片已实施并通过 GPU 回归；完整 CSM 数学单源化仍待后续裁决。两端规划器、资源布局和作者阴影保持现有设计。

## 现状核查

以下六步与差异表记录实施前状态；后续授权切片及证据见文末。

| 六步 | 已有（不重建） | 真实缺口/边界 |
|---|---|---|
| 1. 源码与未跟踪文件 | 检索了 packages/apps 的 CSM、PCF、cascade、blend，检查 git status。TS 主渲染、DeepSL 包适配、native 各有真实 CSM 采样实现；shadows/、packageAdapterCsm.ts 和 native_cascaded_shadow_v1.wgsl 没有在途修改。 | 共享 WGSL 登记中尚无 CSM 数学家族。本轮输出家族/生命周期等未跟踪文件不能视作 CSM 实现。 |
| 2. 契约层 | `shadows/types.ts` 有相机、options、slice、plan；`shaderAbi/contractV2.ts` 已冻结 336B CSM ABI；native `cascaded_shadow.rs` 同为 336B。contracts 能力清单已有 `shadow-cascades`、`shadow-local`。 | TS 主渲染 624B ABI 与包/native 的 336B 不同；没有共同采样输入及边界数值的对拍夹具。 |
| 3. 依赖 | 现有 esbuild、Vitest、@webgpu/types、playwright/Chrome、wgpu 30、serde_json，以及 WGSL 同步器和 checksum 先例。 | 不需要新增 shader IR、转译器或依赖。 |
| 4. 消费方 | TS 主 `pbrShader.ts` 组合 CASCADED_SHADOW_WGSL；`CascadedShadowResources` 调用 planner/packer 并配置深度数组；DeepSL `adaptCsmWgsl` 已进入真实 shader package；native `frame_bindings.rs` 普通/RT mesh 都拼入 native_cascaded_shadow_v1.wgsl，`ShadowMap` 上传计划。 | 必须覆盖三个消费族，不能只改主 TS 与 native 而漏 DeepSL 包。 |
| 5. 测试与证据 | TS planner/shader/quality/resources/DeepSL CSM/包执行已有测试；native `tests/cascaded_shadow.rs`、shadow_map_tests、shadow_fit_gpu_tests 和 shader ABI descriptor 测试已有；TS lab 有真实 cascade depth-array/PCF probe。F7 真机证据是局部光分页评估，Z1 是默认画质，二者都不是双端 CSM 数学对拍。 | 现有 shader 测试主要锁字符串、ABI 和包黄金值，没有两端零宽混合区、分界点、PCF 输出的共同 GPU 数值门。 |
| 6. 规格/交接/台账 | 已读 0930 交接、恢复台账、剩余估时表 J2-B4，及 research 的 TS-Rust 能力矩阵 S1/W-9/W-11/B4；交接要求性能收益可测，允许不立项。 | 旧 B4 表的“Rust 预算允许则抬到 8”不是本刀前提；当前最小修复无需升级 native 级联容量。 |

## 三个真源及实际路径

| 消费族 | 当前真源 | 采样入口/配置 |
|---|---|---|
| TS 内建 PBR | `packages/deep-engine/src/shadows/cascadedShadowShader.ts` | `deepCascadeIndex` / `deepSampleCascade` / `deepCascadedShadow`；8 个固定矩阵槽，156 float=624B，group 2 bindings 0/1/2。 |
| TS DeepSL Shader Package v2 | `packages/deep-engine/src/shaderAuthoring/packageAdapterCsm.ts` | `DEEP_PACKAGE_CSM_WGSL` 经 adaptCsmWgsl 注入正式模块；4 槽/336B，group 0 binding 7；模块进入 Native 共享黄金 package fixture。 |
| Native 普通/RT mesh | `packages/deep-engine-native/assets/shaders/native_cascaded_shadow_v1.wgsl` | `cascade_index` / `sample_cascade` / `shadow_visibility`；4 槽/336B，group 0 bindings 1/2/7；同文件还有 local spot PCSS/PCF 和 point face，不应整文件迁出。 |

三份均实现：逐 split 选层、世界法线位移、光空间投影、UV 翻 Y、域外返回 1、3×3 comparison PCF、邻级 smoothstep/mix。每份都有独立维护的 PCF 循环和混合逻辑；DeepSL 注释声称与 native 同式，实际没有共同字节门锁住这段数学。

CPU planner 也都已存在。TS `cascadedShadowPlanner.ts`：1–8 级联、practical split、半径量化与 texel snap、下一层从前层 blendStart 覆盖。Native `cascaded_shadow.rs` + `cascaded_shadow_math.rs`：2–4 级联，同样 split/snap/重叠，另外按 SceneWorldBounds 修剪接收距离和拟合 caster depth。两端并非从零缺 CSM。

## 已证实的差异与尚未复现的风险

| 项 | 源码事实 | 处理判断 |
|---|---|---|
| 零宽混合区保护 | 主 TS `cascadedShadowShader.ts:94` 有 `if (blendStart >= split) return current`；DeepSL 与 native 没有。TS/native planner 均允许 blendRatio=0，因此会构造 blendStart=split。 | **真实缺失保护**；源码能确定该输入进入 smoothstep 零宽区间，NaN、具体 GPU 求值和画面异常未实测，不能写成“已复现除零/漏影”。先补边界门，再补同一保护。 |
| 无混合区重复采样 | 非末层且存在混合宽度时，三份都先采当前层，再把下一层采样直接作为 mix 的参数；没有 viewDepth≤blendStart 的提前返回。 | **优化候选**；源码有 2×9 个显式 comparison 调用，提前返回可将无混合区路径减为 9；这不是实际纹理读取计数或帧时收益，编译器优化与分支成本需同机测。 |
| 级联容量/ABI | TS 主支持 1–8，native planner 2–4，DeepSL/native 336B，TS 主 624B。 | 宿主能力/布局边界；共享小数学核可保留各自容量，不升级 ABI，不据此宣称容量对等。 |
| 视深来源 | TS 实际调用在 `wgsl/directDisplay.wgsl:5`，取 max(-worldToView.z,0)；native/DeepSL 取 dot(world-eye,camera_forward)。 | 对规范同相机前方点数学可一致，但 TS clamp 和浮点求值不同。双端夹具传明确 viewDepth 后测共同数学，视深适配另测；不盲改坐标体系。 |
| 法线偏置 | 主 TS 支持 slope/constant-one-texel 的 params.w；native/DeepSL 固定 slope。 | 保留 TS 策略选项；共同子集固定 slope。作者 shadow 的五 tap、强度和抖动分支不归 CSM 3×3 首刀。 |
| 默认参数 | TS planner 裸默认 blend=0.1、最大距离取 camera.far；native 默认 blend=0.12、距离40；TS 生产 high=0.12，生产 depthBias=0.00075 与 native 相同，不能用 packer 裸默认0.001误判生产漂移。 | 公共测试显式冻结参数，不把 API 默认和产品默认混写，不顺手改产品质量策略。 |
| map size/场景拟合 | TS balanced=1536且支持整数尺寸；native要求至少64的2次幂。Native有scene-fit，TS上述planner没有同一scene-fit。 | 宿主合法域和几何策略差异；首刀取共同128/256/2048尺寸，不硬统一规划器。 |

另一个维护注意点：TS Math.round 与 Rust f32.round 在负半整数取整处不同，planner 矩阵对拍若未来扩域，需要明确取整和 f32/f64 口径；本次未构建对应反例，不将它列作已复现缺陷。

## 核查时的后续方案

先做“零宽混合区行为修复与共享 blend 核”，再决定是否扩大 PCF 单源。不要直接迁整份 native shader、重做 shadow planner、升级 native 8 级联或替换分页阴影。

1. 预注册采样夹具：同一两层深度图、矩阵、map size、slope bias、explicit viewDepth；覆盖 blendRatio=0、blendStart−ε/等于/中点/split、最后级联、超最后split、域外UV/depth、normal平行/斜向。硬区域预期 lit/shadow，混合区有限且单调、边界连续。三族都执行生产 shader 函数。
2. 只补 native 与 DeepSL 缺失的 blendStart≥split 保护，主 TS 已有保护保留。DeepSL 包模块/缓存 hash 会随 shader 改动变化，必须通过正式 compiler 重新生成黄金 fixture，不能手改包 hash 掩盖漂移。
3. 抽一个不引用绑定、不规定矩阵槽数的共享 scalar blendWeight helper；各宿主保留选择/读取 split、取矩阵、texture/sampler 和 viewDepth 的薄适配。按现有 WGSL sync、sidecar、镜像与 native include 纪律接真实消费。
4. 如共同门证实收益，下一子刀共享接收点/UV 和 3×3 PCF 小函数，并加入混合区前提前返回；GPU 计时必须与正确性迁移分开记录，不能用减少源码行数代替提速。

### 下一刀精确文件域

- 新真源候选 `packages/deep-engine/wgsl/cascadedShadowMath.wgsl`、`.wgsl.sha256`；生成镜像 `src/shadows/cascadedShadowMathWgsl.ts`；只追加登记 `packages/deep-engine/scripts/syncSharedWgsl.mjs`，同源门按既有 checksum 家族追加。
- 真实消费修改：`src/shadows/cascadedShadowShader.ts`、`src/shaderAuthoring/packageAdapterCsm.ts`、native `assets/shaders/native_cascaded_shadow_v1.wgsl` 只替共同函数；native `src/frame_bindings.rs` 增加共享 include 拼接。所有测试侧 mesh 拼接也必须检索更新，例如 native `tests/support/shader_material_renderer.rs`、`tests/support/lod_draw_renderer.rs`、`src/renderer/rt_pixel_tests.rs`，避免产品可编译、测试拼接漏库。
- 边界/黄金测试：现有 `src/shadows/cascadedShadowShader.test.ts`、`src/shaderAuthoring/packageAdapter.csm.test.ts`、`deep-engine-native/tests/cascaded_shadow.rs`；重新生成 `deep-engine-native/tests/fixtures/deep_shader_package_csm_v2.json`。不要改 frozen ABI `contractV2.ts` 或 native uniform byte count。
- 共同输入候选 `packages/deep-engine/fixtures/j2-csm-parity-v1.json`，TS 扩既有 `lab/cascadedShadowProbe.ts` 或邻接 probe，native 用真实 CSM shader 加读回测试，沿用现有 comparison 工具；对拍通过后才追加 J5 一对，不新建门禁平台。

以上共享数学文件仍是候选，本次授权切片未创建共享核、未改变同步器或 ABI。

## 可复用测试和真机入口

| 入口 | 已覆盖 | 需要补什么 |
|---|---|---|
| `lab/cascadedShadowProbe.ts` → `lab/engineCapabilityProbeSuite.ts` | 真实 caster 写两层 depth-array，再调用生产 CASCADED_SHADOW_WGSL 读回；检查选层/PCF。 | 当前2像素仅验证lit/shadow，不覆盖零宽混合、分界点或GPU帧时；sampler nearest，生产linear。需冻结并说明过滤差异。 |
| `lab/authorLodIntegrationProbe.ts` | 正式PbrRenderer HDR/shadow attachments读回及incremental上传。 | 当前exact单级，没有CSM混合；可复用真实附件读回，不能直接当混合门。 |
| native `src/shadow_fit_gpu_tests.rs::nvidia_scene_fitted_shadow_update_is_transactional` | 真实GPU读取336B sampling uniform、失败回滚和成功publish。 | 证明规划/事务，不证明3×3 PCF或blend输出；不替代新采样读回。 |
| native `tests/cascaded_shadow.rs` | 2–4级联、336B、texel snap、scene-fit和生产拼接合同。 | 补零宽输入，去掉仅“存在smoothstep字样”即可通过的盲点。 |
| TS `shaderAbiV2.test.ts` / `shaderPackageCsm.test.ts`；native `shader_package/gpu_descriptor_tests.rs` | 4级联shader-package ABI、纹理数组binding、缓存隔离。 | 保留回归；这些不是GPU阴影画质门。 |

核查阶段只读既有测试与证据。实施阶段另复用了真实生产函数和 Native 生产渲染测试，见文末命令；没有新建 Native GPU 平台。

## 性能影响与单源化裁决

共享函数/生成镜像是构建期拼接，首刀不增加纹理、uniform、draw、运行期编译步骤或采样次数。必须保持624B/336B布局、depth-array尺寸及旧非退化输入结果；共享字节可以降低三份公式维护风险，**不能承诺FPS提升**。

提前返回候选：无混合区的源码comparison函数调用从18到9，混合区仍18，最后层原本9不变。运行期增益 unmeasured；后续同设备、同shader输入，3轮暖机后比较两次独立运行的timestamp p50/p95，并检查稀疏/密集混合区比例与非回归。分支不获益时保留正确性修复和共享blend，不为单源化硬上优化。

裁决：**先完成边界门与窄修，再评估小数学核**。缺失保护已补，三份公式仍分别维护；完整 J2-B4 单源化、共同 Native 边界输入和 GPU 帧时验收未完成。

## 授权最小切片与验证

本次只改三个生产采样函数：保留末级早退，在第二级 PCF 与 smoothstep 前统一增加 `blendStart >= split || viewDepth <= blendStart` 早退（native 使用 snake_case）。正宽区间在 viewDepth=split 仍进入混合并取下一层权重 1；零宽区间在 split 取当前层，超过 split 后选下一层。没有修改级联容量、规划器、binding、uniform 字节数或材质阴影策略。

DeepSL/native 原源码缺失零宽保护已确认；NVIDIA Lovelace 的改前两轮实测没有产生 NaN 或画面异常。此次是显式边界保护与冗余采样路径削减，不能据此写成“已复现除零”。无混合区源码显式 comparison 调用从 18 到 9，混合区仍为 18；没有测 GPU timestamp 或 FPS。

### 边界 GPU 证据

`node scripts/j2-csm-boundary-gpu.mjs` 使用 Chrome WebGPU/Dawn 实际执行 TS 内建、DeepSL 包、native 文件中的生产 CSM 函数。输入是两层恒定深度 0.75/0.25、接收深度 0.5，nearest comparison sampler；每层真实 3×3 PCF。每族两种 blendStart（1.8、2）×七个 viewDepth（1、1.8、1.9、2、2.1、4、4.1），同一 fragment quad 内存在跨边界深度。

改前 `--baseline` 与改后各两轮：结果有限、重复稳定、逐样本改前改后一致。正宽区间最大误差 `5.960464477539063e-8`，零宽误差 0。证据 `test-output/interrupted-0930/csm-boundary/evidence.json`：`passed=true`、`stable=true`、`beforeAfterValuesEqual=true`。JSON 中同时保存每族实际拼接 shader 的 SHA-256 `sourceHash` 与采样库的 `libraryHash`，由既有 `sha256Utf8` 计算。

| 实际采样族 | 当前执行 shader sourceHash |
|---|---|
| ts-built-in | `12182955135cd4001e2fe1b255681c7b6a8a8bf46f0ee56b1a958921deecd41b` |
| ts-deepsl-package | `fb51dd84adb778a9a9c0ced48ab47e4e0df499ff0f67e81f6fbb30ac3d14f355` |
| native-production-wgsl | `5aca64d040190f468a581c41b573d98cff19f72238ebbbcb02e0bc7cccc3682d` |

这里的 native 采样族是 native 生产 WGSL 在 Chrome 上执行，不是 Native wgpu 宿主。nearest/恒定深度夹具没有覆盖生产 linear PCF 边缘过滤、完整场景画质、相机/规划器对拍或计时。

### 正式包与宿主回归

`node scripts/regenerate-csm-package-fixture.mjs` 调用既有正式 `adaptDeepSlStandardToShaderPackage` 和测试同一请求，重新生成 `packages/deep-engine-native/tests/fixtures/deep_shader_package_csm_v2.json`；模块、内容和缓存 hash 均由 compiler 生成。

TS focused 回归命令（在 packages/deep-engine 下）：

```text
pnpm exec vitest run src/shadows/cascadedShadowShader.test.ts src/shadows/cascadedShadowEarlyExit.test.ts src/shadows/cascadedShadowPlanner.test.ts src/shaderAuthoring/packageAdapter.csm.test.ts src/webgpu/shaderPackageCsm.test.ts src/shaderAbi/shaderAbiV2.test.ts
```

结果 6 文件、42 passed、2 个既有 Naga 条件测试 skipped；core/lab 类型检查通过，sourceSizeGate failures=0。新增测试检查三份真实函数的早退先于下一层采样和 smoothstep，且不会错误截断正宽区间的 split 端点。

主线串行执行 Native 真 GPU 入口：

```text
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --test gpu_shader_material_draw -- --ignored --nocapture
```

`test-output/interrupted-0930/csm-native-gpu.log`：4 passed、0 failed，11.30s。生产 Player 高低 LOD、HDR/四级 CSM 输出精确对拍、透明排序、first-cascade 复用负例、坏包隔离及 last-good/new-device 像素回归通过。这是 Native 生产集成证据，覆盖面与 Chrome 七点边界夹具不同。

主线另执行 `--test cascaded_shadow`：8 passed；`--lib csm_array_and_uniform_descriptors_preserve_non_dynamic_shadow_frames`：1 passed。core/lab/examples 类型检查及 TS build 通过；WASM 重建由主线单独记录。

首跑暴露既有测试 helper 自行拼接 mesh/CSM 时漏掉 J2-B1 公共库，报 `deepDielectricF0` 未定义。主线将 `tests/support/shader_material_renderer.rs`、`lod_draw_renderer.rs` 改为复用生产 `frame_bindings::create_native_mesh_shader` 后复测通过；该接缝修复属于主线文件，不新增 shader 数学设施。

### 视觉核查与剩余范围

按 design-taste-digitaltwin 读取渲染验收要求；边界夹具使用现有 base.css 令牌，改后两轮截图 `after-round-1.png`、`after-round-2.png` 已逐张检查，中文标题、六组采样带和数值标签完整，无裁切。此夹具用于数值检查，未进行完整产品场景的 Kimi-95 十维视觉评分。性能实测、linear 过滤边界、跨设备零宽求值、Native 同七点输入，以及是否抽共享小核仍是后续项。
