# I-C23 Native 分层材质生产消费 + 双端白炉 CPU 参考（2026-10-01）

接续 `i-c23-production-layered-material-20260930.md`（Web 首刀 4debbb8d + Browser
补刀 fe963a04 已冻结）。本刀交付 I-C23 剩余的 **Native 侧**：生产 shader 消费
分层材质响应核、契约/管线/绘制路径接线、双端白炉 CPU 参考与对拍 fixture。
GPU 实测按铁律留给主线程统一串行。

## 现状核查（六步，2026-10-01 实测）

1. **全仓 grep（layeredMaterial/layered/分层，含未跟踪）**：Web 侧单源
   `shader/materialLayered*.ts`、GPU 侧 `webgpu/pbrLayeredMaterial*.ts`、
   304B 绑定 `LAYERED_MATERIAL_UNIFORM_BINDING=13`/`REQUIRED_TEXTURES=19`、
   lab/runner 均已在仓（Web 已验，不重建）。Native 侧仅有
   `deep2d/runtime_types.rs` 一处同名误命中；`packages/deep-engine-native`
   无任何分层消费实现——真实缺口确认。
2. **契约**：TS `ExtendedMaterialParameters`（6 键 f32）、
   `LayeredMaterialParameters`（base+≤2 层、replace/overlay、22-f32）、
   `LayeredSurfaceParameters`（按层 surface + 304B 块 ABI v1）齐全；
   `renderPacketTypes.ts` 的 `PreparedMaterialTextures.layered` 齐全。
   Native `contract/types.rs` 的 `PbrMaterial` 为 `deny_unknown_fields`，
   无 `layered`/`extendedParameters`——契约缺口确认。
3. **依赖与消费方**：Web 生产入口 = pbrShader.extendedShade →
   `composeLayeredMaterialSceneShader`（opt-in）。Native 生产 shader =
   `native_mesh_v1.wgsl`（+RT 变体），材质 group(1) 绑定 0..10、160B
   uniform、五纹理；`native_mesh_wgsl.rs` 已有跨包 include_str! 单源链
   （materialDielectric/brdfDirectLighting/brdfDirectMultiscattering/
   iesSampling）——分层混合核可走同一链。无另一份 hydration 实现。
4. **测试证据**：`test-output/i-series-0930/layered-material-production/
   evidence.json`（Web 两 fresh 全绿）与 `layered-material-rehydrated/`
   在仓（规格有精确记录）。Native 无分层证据。
5. **规格**：`i-c23-production-layered-material-20260930.md` 明确保存重开
   补刀已完成、Native 闭字段严格拒绝、Native 消费与双端白炉是整项剩余。

**已有（不重建）**：Web 全链（含 304B 打包/绑定/19 纹理能力门/两轮实帧
证据）、WGSL 混合核单源 + checksum 门、CPU 白炉模块（white_furnace.rs）、
Native 固定 wgpu/serde 契约、mesh 管线族与场景缓存。

**真实缺口（本刀交付）**：Native 契约层栈字段、304B 块的 Rust 打包、
native mesh WGSL 层消费核、分层管线族/绑定/能力门/绘制分支、TS→Native
发布白名单放行、双端对拍 fixture 与 CPU 白炉参考。

## 方案与锁

### 304B 块与绑定映射（与 Web 逐位兼容）

- 布局不变：header 16B（word0=activeCount、word1=ABI v1）+ 2×144B 行
  （params0/params1/colorCoverage/surfaceMode/baseRow0/baseRow1/mrRow0/
  mrRow1/indices）。Rust `pbr_layered::pack_layered_surface_block` 与 TS
  `packLayeredSurfaceBlock` 逐位对拍（fixture 门双端钉死）。
- Native 材质 group(1) 绑定 0..10 不动；**分层扩展 layout = 0..10 同构 +
  binding 11（304B uniform）+ bindings 12..19（四对层纹理/采样器，
  [base0, mr0, base1, mr1]）**。层槽缺纹理借中性 fallback（1×1 白已由
  fallback 家族覆盖）。既有 192B/224B/160B ABI 一律未动。
- 能力合同常量 `LAYERED_MATERIAL_REQUIRED_TEXTURES = 19`（与 Web 互钉）；
  native fragment 实际采样纹理 13（shadow/env/LUT 4 + 基材 5 + 层 4）≤
  默认 16，但按 Web 同一合同请求并检查 19（gpu_context 请求 clamp 到
  适配器；init 门 fail-closed）。

### Native 求值语义（诚实边界）

- 层响应 = `native_lit_response`（抽自 shade_native_mesh 的 stock 光照核：
  直射 + 多散射 + 局部光 + IBL/GI + emissive），与 Web 层求值 **stock 分支**
  逐式同构；扩展词全零时（白炉 fixture 即如此）双端语义逐位同构。
- 层 ior 经介电 F0 通道消费：`select(instanceDielectric,
  deepDielectricF0(params0.x), params0.x >= 1.0)`——Web compose 后
  `replaceAll("v.dielectric", "dielectric")` 插入行的同式镜像。
- **层的 clearcoat/各向异性/透射词随 304B 块携带但 native 不评**：native
  基材本就没有 extendedParameters 求值核，层与基材同界，不是本刀新增
  缺陷；扩展 lobe 消费是显式后继项（需先建 native 扩展求值核）。
- 层纹理 alpha 乘 coverage（`coverage *= color.a`）、MR 乘金属/粗糙，
  混合在曝光/雾之前（Web 每层响应含雾再混合；replace 模式由线性可拆性
  逐位等价，overlay 差二阶，白炉环境无雾不受影响——已记录）。
- 混合核用唯一真源 `wgsl/materialLayerBlend.wgsl`（include_str! 进链，
  与 TS checksum 门共享同一文件）。

### 入口与管线族（普通路径逐位不变）

- 同一 shader 模块内新增 `fragment_main_layered` /
  `fragment_normal_capture_layered` / `fragment_main_rt_layered` 入口；
  **普通入口调用图不触及 binding 11..19**（naga 静态使用分析），普通管线
  沿用 v1 材质 layout，普通路径零扰动（源契约测试已更新为单源锁）。
- `MeshPipelines` 增加可选分层颜色族（solid/blend/blend_premultiplied ×
  standard/normal_mapped × 三 raster，选择轴与 `select` 同构）。
  `create_mesh_pipelines_with_layered` 仅在"能力就绪且包内确有分层材质"
  时驻留；无分层材质时管线预算与普通路径完全不变。
- 光照响应体抽为共享函数 `native_lit_response` + `deep_layer_stack`，
  RT 变体经函数共享（同步契约从文本重复升级为单源；white_furnace/
  lighting_math_wgsl 源契约锁同步更新并保持双侧锁定语义）。

### fail-closed 门（不静默丢层）

1. **设备能力**：`max_sampled_textures_per_shader_stage` 请求 19（clamp）；
   包内含分层材质而设备 < 19 → renderer init 显式报错。
2. **RT pixel 路径**：`rt_opaque_ready` 新增条件 5——含分层材质的场景整帧
   回退栅格（与 custom shader 场景同语义；RT 分层管线族留给后继）。
   `draw_rt_batch` 保留 debug_assert 兜底。
3. **custom ShaderPackage**：分层材质进 custom 绑定路径显式拒绝（v1 普通
   组会静默丢层）。
4. **C3 增量快路径**：`classify_material_resources` 把层行存在性/块内容
   变化判为 Structural（304B 块不在 160B 快路径内，原位覆写会丢层）；
   `instance_material_words_unchanged` 同步加 layered 恒等守卫。
5. **TS→Native 发布**：native profile 放行 `layered`（与 Browser 同一
   fail-closed 校验路径，`layeredMaterialExtension` 独立导出）；
   `extendedParameters` 仍是 Browser-only（native 契约 serde 会拒绝）。
6. **契约**：`PbrMaterial.layered`（serde，deny_unknown_fields 家族）：
   层数 ≤2、coverage/surface 通道 ∈0..1、mode 白名单（serde 层即拒）、
   层纹理槽走与基材同槽校验 + UV-set 需求合同（`MaterialFeatures`）。

## 双端白炉 CPU 参考（本刀交付，GPU 轮留给主线程）

- **fixture**：`packages/deep-engine/fixtures/i-c23-native-layered-block-v1.json`
  —— 由 TS 单源真函数（`lab/iC23NativeLayeredFixture.ts` + 
  `scripts/i-c23-native-layered-fixture.mjs`）生成：规范层栈（层 0
  overlay+双纹理 UV1/缩放、层 1 replace 纯色）、**304B 块 76-f32 金标**、
  5 个混合闭式案例（与 materialLayeredEvaluate 同运算序）、白炉凸性案例
  （base 0.9 + 两层 → blended + ≤1 界）。
- **对拍链**：WGSL 单源（checksum 门）→ TS 权威（packLayeredSurfaceBlock /
  blend 闭式）→ fixture（vitest 漂移门 lab/iC23NativeLayeredFixture.test.ts）
  → Rust（pbr_layered.rs + pbr_layered_contract_tests.rs 逐位对拍）。
- **白炉先验**：两种混合模式均为凸混合（逐通道权重和恒 1）⇒ 输出 ≤
  max(双亲) ≤ 1，白炉口径 ≤1 由双亲直接继承（`furnace_bound_holds`，
  CPU 测试已证）。GPU 白炉轮预期：E=0.5 全白 Lambert 基材 + 彩色层，
  渲染输出应落在 CPU 闭式预测的凸包内，逐通道误差沿用既有炉容差。

## 修改/新增文件清单

**Native 契约与参考（新增）**
- `packages/deep-engine-native/src/pbr_layered.rs`（304B pack + 混合闭式 +
  白炉凸性 + 9 CPU 测试，含 fixture 逐位对拍）
- `packages/deep-engine-native/src/pbr_layered_contract_tests.rs`（serde/
  validate/prepare 端到端 5 测）
- `packages/deep-engine/fixtures/i-c23-native-layered-block-v1.json`（生成物）
- `packages/deep-engine/lab/iC23NativeLayeredFixture.ts` + `.test.ts` +
  `scripts/i-c23-native-layered-fixture.mjs`（TS 权威端与漂移门）

**Native 接线（修改）**
- 契约：`contract/{types,mod,validate,uv_sets,validate_texture}.rs`
- 准备/绑定：`pbr_texture.rs`（PreparedMaterial.layered + 层纹理索引）、
  `gpu_textures.rs`（分层 layout + LayeredGpuMaterial 0..19 全槽 bind group）
- 管线：`pipeline/{mod,mesh}.rs`（分层族 + select_layered + *_layered 入口）
- 绘制：`gpu_scene_draw.rs`（bind_color 分层分支；RT debug_assert）、
  `renderer/frame.rs` + `renderer/rt_residency.rs`（RT 回退门条件 5）、
  `gpu_shader_materials.rs`（custom 路径拒绝）
- 场景缓存：`gpu_scene_cache.rs`（with_layered_material_layout）、
  `gpu_scene_cache_stage.rs`、`gpu_scene.rs`、`renderer/init.rs` +
  `renderer/init/resources.rs`（能力门 + 分层管线族创建）
- 设备：`gpu_context.rs`（19 采样纹理请求）、`renderer/material_resource_diff.rs`
  （Structural 守卫）
- WGSL：`assets/shaders/native_mesh_v1.wgsl`（层绑定声明 + native_lit_response
  重构 + deep_layer_stack + 分层入口）、`assets/shaders/native_mesh_rt_fragment_v1.wgsl`
  （共享函数化 + 分层入口）、`native_mesh_wgsl.rs`（materialLayerBlend.wgsl 进链）
- 源契约锁更新：`white_furnace.rs`、`lighting_math_wgsl.rs`（单源化后的
  计数/位置断言，锁定语义不变）
- 测试调用点机械更新：`gpu_scene_cache_stage` 族 GPU 测试 +rt 第 4 参等

**TS（修改）**
- `runtimePackage/renderPacket.ts`（native profile 放行 layered）
- `runtimePackage/renderPacketBrowserMaterial.ts`（layeredMaterialExtension
  独立导出）
- `runtimePackage/renderPacketBrowserMaterial.test.ts`（native 接受 layered
  + 5 个 fail-closed 用例）

## 验证记录（本机实测，2026-10-01）

| 命令 | 结果 |
|---|---|
| `cargo test --lib`（deep-engine-native） | **694 passed / 0 failed**（1 ignored=GPU 门） |
| `cargo test --lib pbr_layered` | 14 passed（含 TS fixture 逐位对拍） |
| `cargo check --lib --tests` | 0 error |
| `pnpm --filter @bim-studio/deep-engine run typecheck`（tsc + lab + examples） | 0 error |
| `vitest run src/runtimePackage src/shader/materialLayered* src/renderPacketMaterials.test.ts` | **455 passed** |
| `vitest run lab/iC23NativeLayeredFixture.test.ts` | 2 passed（fixture 漂移门） |

## GPU 步骤（留给主线程的精确命令）

前置铁律：真实 GPU/共享构建由主线程统一串行；本刀未跑任何 GPU 实测，
WGSL 的真实模块编译（naga 全量校验）也在 GPU 轮首帧 error scope 内完成。

```bash
# 1) native CPU 回归 + WGSL 源契约锁（无 GPU，可先跑）
cargo test --lib -p deep-engine-native

# 2) native 真机 GPU 门测试族（白炉/RT 回退/材质绑定读回;含既有 GPU 门)
cargo test --lib -p deep-engine-native -- --ignored --nocapture white_furnace
cargo test --lib -p deep-engine-native -- --ignored --nocapture rt_fallback
cargo test --lib -p deep-engine-native -- --ignored --nocapture rt_raster_parity

# 3) native 分层白炉轮（主线程新增,建议最小步骤):
#    a. 用 fixtures/i-c23-native-layered-block-v1.json 的规范材质构造
#       RenderPacket（基材白 0.9 + 层 0 [0.8,0.2,0.1]/coverage .75/overlay +
#       1×1 纹理,层 1 [0.1,0.9,0.4]/coverage .5/replace）;
#    b. E=0.5 全白 Lambert 炉环境,深色 1920×1080 两 fresh;
#    c. 读回 HDR,逐通道对照 fixture.furnace.blended 的凸包闭式预测;
#    d. 参数关闭（coverage=0）回归与无层身份保持（before/after 源 SHA 相同）。

# 4) Web 侧既有门不受影响（已冻结,复核用）:
node scripts/i-c23-production-layered-material.mjs   # C23_GATE_MODE=production
```

## 未做与风险（诚实条款）

1. **未跑任何 GPU 实测**：WGSL 分层消费核未经 naga 真实模块编译与真机
   渲染验证。风险点：`diagnostic(off, derivative_uniformity)` 在 wgpu 30
   naga 的接受性（Web 同指令已在用，风险低）、层循环 textureSample 的
   均匀性处理、`fragment_main_layered` 与扩展 layout 的绑定完备性——
   GPU 轮首帧 error scope 会精确暴露。
2. **RT 分层管线族未建**：含分层材质场景整帧回退栅格（fail-closed，
   功能正确但放弃 RT 像素路径加速）；后继可加 `fragment_main_rt_layered`
   管线族（WGSL 入口已就绪）。
3. **custom ShaderPackage 不支持分层**：显式拒绝（明确报错，不静默）。
4. **native 不评层扩展 lobe（clearcoat/各向异性/透射）**：随块携带但不
   消费，与 native 基材无 extendedParameters 求值同界；需要 native 扩展
   求值核后继项。
5. **overlay 雾序差**：Web 每层响应含雾再混合、native 混合后一次施雾；
   replace 逐位等价、overlay 差二阶（雾混合是标量混合），白炉环境无雾。
6. **GPU 白炉轮的对拍脚本**（构造包 + 读回 + 闭式对照的 runner）未写——
   属 GPU 轮工作，CPU 参考值与凸包预测已就绪（fixture.furnace）。
7. 本刀修改了其他组拥有的两个源契约锁测试（white_furnace.rs、
   lighting_math_wgsl.rs）——原因是光照体单源化使字面公式从 RT 文件移入
   本体共享函数；锁定语义（C12 修复式 + 多散射双消费点）保持并加强
   （新增 RT 必须消费共享函数、禁止文本副本的断言）。若 C8/J2 owner 对
   锁形态有异议需回溯，以"单源 + 函数共享"为对齐基准。
