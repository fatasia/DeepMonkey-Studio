# R2 跨后端着色 IR 设计（2026-09-19）

> 车道：R2（`de26-high-value-scope-analysis-2026-09-19.md` §8.2）。
> 目标形态：**一套着色源 × 三后端（WGSL/WebGPU、GLSL/WebGL2、WGSL/Native wgpu）× 确定性结果**。
> 对位超越逻辑：Three TSL 不编译到 Native 后端；Babylon compute 不承诺跨端确定性；四引擎无一以
> "跨后端着色数值一致"为产品合同。本文是 R2 第一波切片的设计与现状依据。

---

## 1. 现状地图（2026-09-19 审计，先读后写产物）

### 1.1 着色源盘点：每类源 → 后端 → 编译路径 → 消费点

| # | 着色源 | 位置 | 形态 | 后端 | 编译路径 | 消费点 |
|---|---|---|---|---|---|---|
| S1 | Deep Shader IR（schema 1，typed 节点 DAG） | `packages/deep-engine/src/shader/` | 类型化节点图（literal/property/attribute/varying/算术/纹理采样等 ~24 op），vertex/fragment 两阶段 | **仅 WGSL** | `compileShaderPass()` → `emitShaderPass()`（`compilerWgsl.ts`，确定性逐 `let n_id` 展开 + sourceMap + sha256 cacheKey） | DeepSL 编辑器编译、`shaderPresets`（Standard/Unlit） |
| S2 | DeepSL 文本 DSL | `packages/deep-engine/src/shaderAuthoring/` | `shader deep.material { surface standard; … }` 文档 → 模型 → preset 图 | 仅 WGSL | `parseDeepSlDocument` → `adaptDeepSlToShaderPackage` → `buildStandardSurfaceShader` → S1 同路径；编辑器侧再经真实 device `getCompilationInfo` 回诊 | 编辑器着色创作（`webgpu/shaderAuthoringCompiler.ts` 桥） |
| S3 | 手写 WGSL 常量（渲染） | `packages/deep-engine/src/webgpu/`（pbrShader、pbrDirectLightingWgsl、cluster*、weightedOitWgsl、pbrFogWgsl 等） | 内联模板字符串 WGSL | WGSL | 直接 `device.createShaderModule`（`pipelines.ts`、各 pass 类） | PBR 管线、OIT、雾、背景/地面 |
| S4 | 手写 WGSL compute 内核 | `packages/deep-engine/src/webgpu/`（hiZPyramid、gpuFrustumCulling、gpuSkinning、gpuMorph*、gpuParticle*、gpuLod*、meshlet*、hiZInstanceCompactor 等） | 内联 WGSL，`@compute @workgroup_size` | WGSL（WebGPU） | 各运行类自建 pipeline | HiZ 遮挡剔除、蒙皮/变形、粒子、LOD 预算、meshlet 间接绘制 |
| S5 | GI 探针 clipmap | `packages/deep-engine/src/lighting/`（probeClipmapSamplingWgsl、clusterComputeWgsl、webgpuProbeCaptureWgsl + CaptureExecutor 事务） | 内联 WGSL（采样/capture/filter/mip） | WGSL | `webgpuProbeCaptureAdapter` → capture/filter/mips 三段 encode | 探针更新（E03）、cluster 灯光（E05）、PBR 采样 |
| S6 | Native 引擎 WGSL | `packages/deep-engine-native/assets/shaders/native_*.wgsl`（11 个，经 7 个 rs 文件 `include_str!`） | 独立手写 WGSL | WGSL（wgpu） | Rust `gpu_culling.rs`、`bloom_pass.rs` 等直接装载 | Native culling/LOD/bloom/output/shadow/mesh/deep2d |

### 1.2 现有 compute 用例（全部 WebGPU 单端）

frustum culling、HiZ copy/reduce（`hiZPyramid.ts`）、instance compactor、skinning、morph、
particle、meshlet indirect、LOD 预算、探针 capture/filter/mip、cluster grid。**没有任何 GLSL 生成；
compute 内核没有任何跨端共享源。**

### 1.3 重复/分叉点（R2 要收口的债务）

1. **Web↔Native 双份手写 WGSL**：`webgpu/gpuFrustumCulling.ts` 与 `native_gpu_culling_v1.wgsl`、
   LOD/bloom/output/shadow 各自成对，语义同步靠人工，无数值对拍合同。
2. **S1 IR 是唯一的"IR"，但只出 WGSL、只做 vertex/fragment**：其类型化节点 + 确定性展开 + sourceMap +
   sha256 cacheKey 的骨架可直接复用到 compute 与多后端，未被利用。
3. **确定性只在帧/digest 层**（dynamic-frame-v1），着色层数值无跨端口径；`shaderPackage/hash.ts`
   默认 sort 非字节序（总账 P1-23 记录在案）——新哈希必须字节确定。
4. **WebGL2 无着色体系**：`apps/web/src/rendererCapabilities.ts` 仅探测 webgl2 作发布回退
   （`publication-webgl`），无 GLSL 编译路径。
5. WGSL 校验只有可选 Naga bin（`DEEP_SHADER_NAGA_BIN`）；GLSL 无任何校验。

### 1.4 与 R3 车道的边界

R3 拥有 `apps/web/src/delivery/` 与 `packages/deep-engine/src/runtimePackage/`。本车道不触碰两者；
`shaderPackage/`（S1/S2 的产物包装）与本车道新增的 `shaderCompute/` 无文件交集。

---

## 2. IR 选型

### 2.1 候选

| 候选 | 说明 | 评估 |
|---|---|---|
| A. 扩展现有 Deep Shader IR schema 1 | 给 `shader/types.ts` 加 compute 阶段与整数/存储 op | 复用最大，但 schema 1 被 44 个测试文件与运行包消费冻结；vertex/fragment 与 compute 的 IO 模型差异大，混入会拖累稳定合同 |
| B. 指令级线性 SSA（SPIR-V-lite）+ 文本序列化 | 类 DXIL 中间格式 | 超越 S1 现有形态太远，发射器/验证器/调试体验成本高，第一波交付风险大 |
| C. 函数式 lambda IR（TSL 式） | JS 函数组合生成节点 | 需要第二套"编译期 JS→图"层；Three TSL 已是该形态，不构成差异点 |

### 2.2 结论（选 A′：节点 DAG 子集，独立模块）

新增 **DCIR（Deep Compute IR）v0**，落在 `packages/deep-engine/src/shaderCompute/`：
- 与 S1 同构的**类型化节点 DAG**（依赖序节点表 → 确定性逐节点展开），复用其
  canonical JSON + 纯 TS sha256（`shader/canonical.ts`）做 IR 内容哈希与缓存键；
- 但**独立 schema、独立模块**，不动 schema 1 的任何文件；收敛路径见 §7；
- v0 只收录"确定性白名单 op"（§4），语义即合同：每个 op 的 IEEE/整数语义在两个后端逐一对应。

理由：第一波目标是"单源双后端 + 数值一致"的可证明垂直切片，节点 DAG 让发射器保持哑
（每个节点一行表达式），错误面最小；指令级 IR 留给 v2（若后端数 >3 或需要 SPIR-V 直出再升级）。

### 2.3 DCIR v0 op 集（本切片实际实现）

| 类别 | op | 语义（两后端一致口径） |
|---|---|---|
| 输入 | `global-invocation-id` | vec2u，计算侧=global_invocation_id.xy；GLSL 降级=片段坐标 `uvec2(gl_FragCoord.xy)` |
| 输入 | `kernel-uniform` | 声明式 uniform（u32/vec2u） |
| 字面量 | `literal-u32` / `literal-f32` | 精确字面量 |
| 整数 | `iadd/isub/imul/idiv/imin/imax/ieq/ult` | u32 精确运算，无符号，除法=截断除 |
| 向量 | `make-vec2u` / `component` | 打包/取分量 |
| 浮点 | `fmin/fmax` | IEEE-754 单精度精确选值（无舍入）；NaN 禁入（§4） |
| 浮点 | `canonicalize-f32` | `v + (+0.0)` 单次舍入：把 -0 折叠为 +0，其余位不变 |
| 选择 | `select` | `(cond) ? trueValue : falseValue`，严格求值语义 |
| 纹理 | `texel-load` | r32float 平铺取 texel（坐标必须在界内；越界由 IR 内 select/clamp 前置屏蔽） |
| 输出 | `store` | 目标 r32float 存储/渲染目标写入 |

内核合同：`@workgroup_size(8,8)`；`guard` 节点为真才继续（否则提前退出/discard）；单 `store` 终点。

---

## 3. 后端代码生成路径

```
DCIR kernel（唯一着色源, canonical JSON + sha256 内容哈希）
  ├─ emitKernelWgsl()  → WGSL compute（WebGPU 与 Native wgpu 同文本消费）
  │     WGSL: @compute @workgroup_size(8,8) + texture_2d<f32> / texture_storage_2d<r32float,write> / uniform
  │     WebGPU: device.createShaderModule；Native: 同文本入 wgpu（harness 见 §6/§8）
  └─ emitKernelGlsl()  → GLSL ES 3.0（WebGL2 fragment 降级）
        关键事实：WebGL2=ES 3.0，无 compute 着色器（compute 是 ES 3.1，WebGL 从未暴露）。
        因此 WebGL2 后端把数据并行 kernel 降级为"全屏 fragment pass + 浮点纹理 I/O"：
        - workgroup(8,8) → dispatch 尺寸即 viewport（每像素=一次调用）
        - texel-load → texelFetch；store → R32F FBO 输出（需 EXT_color_buffer_float）
        - uniform → uvec2/uint uniforms；顶点级共享全屏三角（gl_VertexID，无 VBO）
```

降级语义边界（写进合同，不装作等价）：
- 片段坐标 Y 方向与 compute 相反；v0 可移植 kernel 必须 Y 方向无关（本切片的 min/max 归约是
  置换不变运算）；方向敏感 kernel 属 v1（加 flip 旗标），不得静默出图。
- workgroup 共享内存、barrier、workgroup 原子**不可降级**——确定性白名单直接禁止（§4），
  这同时消除了 warp 级不确定原语。
- storage buffer I/O 不在 v0（万灯虚拟灯列表等 buffer 形态在 v1 以 RGBA32F 打包纹理过渡或等
  WebGL compute 扩展），GI 探针球谐更新的存储纹理形态 v0 即可表达。

## 4. 确定性策略（浮点一致性合同）

双档口径：
- **逐位档（bitwise）**：输出按 f32 位型（Uint32 视角）完全一致。允许的 op：§2.3 全部
  （min/max 无舍入、整数精确、select 精确、texelFetch/textureLoad 精确取数）。
- **阈值档（tolerance）**：涉及超越函数/除法/融合乘加的 op（v1+：normalize/pow/sin/cos/exp/
  fma 等），声明 ULP 上限（初版 ≤4 ULP），逐输出记录 maxAbs/maxUlp；不允许进入逐位档。

纪律条款：
1. **禁 warp 级不确定原语**：无 workgroup 共享内存、无 barrier、无原子归约、无 warp shuffle；
   归约一律"每输出线程按固定顺序 gather"。
2. **固定归约顺序**：归约链在 IR 中展开为定序节点链（本切片：种子 → 角(1,0) → 角(0,1) → 角(1,1)），
   两后端发射顺序与求值顺序同构。
3. **-0/NaN 归一**：NaN 禁入逐位档（输入由生产方保证；kernel 若可能产生 NaN 必须显式 select 掉）。
   ±0 并列（min/max 对 -0/+0 的择向在 DXC/ANGLE 下可能不同）由输出端 `canonicalize-f32` 折叠。
   **真机教训（2026-09-19）**：初版按教科书实现 `v + (+0.0)`，实测 ANGLE/D3D11 会把 `x + 0.0`
   代数化简回 `x`（-0 存活）；最终发射为折叠不可消除的 select 形式
   （WGSL `select(v, 0.0, v == 0.0)` / GLSL `(v == 0.0 ? 0.0 : v)`），双端逐位一致。
4. **denormal 与 inf**：denormal 输入可能被任一后端 flush-to-zero（D3D/ANGLE 行为差异），
   列为阈值档风险，单独用例如实记录；+inf 允许作为哨兵值（min/max 对 inf 精确）。
5. **哈希与缓存键**：IR 哈希 = canonical JSON（键排序为码点序，纯 TS sha256，无 locale 语义）；
   输出哈希 = 原始字节 sha256（readback 去除行填充后按行序），规避 `shaderPackage/hash.ts`
   非字节序问题。
6. **验证流程**：同机同浏览器（Chrome）内 WebGPU（Dawn）与 WebGL2（ANGLE→D3D）真实执行，
   外加 CPU 参考实现（同一 IR 语义的 JS 直译）三方对拍；结果与哈希写入 evidence.json。

## 5. 与 R4 万灯/HiZ/GI 探针的接口

| 消费点 | 接入形态（R4 启动时） | 先决 |
|---|---|---|
| HiZ 深度缩减 | `hiZPyramid.ts` 的 `HI_Z_COPY/REDUCE_WGSL` 迁入 IR：copy 内核是平凡 store；reduce 迁移时把现"变窗公式"（`begin = id*src/dst`）替换为 IR 的 2×2 锚定块语义或在 IR v1 加 `window-range` op，二选一后**删除手写 WGSL**，金字塔 class 只保留管线/资源编排 | 本切片（IR+双后端+对拍） |
| GI 探针球谐更新 | capture/filter 内核（r32f/rgba16f 存储纹理形态）迁 IR；球谐系数累加按"每探针单线程定序 gather"表达（白名单内），探针数=dispatch 维度 | v0 IR + 探针事务边界（已有 CaptureExecutor） |
| 虚拟灯采样（万灯） | 采样权重/预算归约先以 gather 形态落 IR（v0 可表达），虚拟灯列表 storage buffer 走 v1 buffer-I/O 或 RGBA32F 打包 | v1 buffer 通道 |

统一 Profiler 接线：kernel 名 + IR 哈希 + 后端标签随 dispatch 进入 `performanceTelemetry`（R4 落地）。

## 6. 本切片实现（2026-09-19 第一波）

- kernel：**HiZ 深度缩减第一档**（2×2 锚定块 min/max，边界 clamp），单一 DCIR 源 →
  `emitKernelWgsl` + `emitKernelGlsl`；min/max 在 IR 层特化（两个模式两个 IR 哈希）。
- **真机发现与对策（本次切片最重要的实证产出）**：
  1. ANGLE/D3D11 对"两个 uvec2 后跟一个 uint"的 uniform 打包存在 quirk——`uint` uniform
     经 `uniform1ui` 写入、`getUniform` 回读正确，但 shader 实际恒读 0（诊断程序直出证据在
     evidence.json `uniformShaderEcho`）。对策：模式从运行时 uniform 改为 **IR 级特化**
     （与生产 HiZ 用 pipeline 常量的做法一致），kernel 仅剩两个 uvec2 uniform，双端证实正确。
  2. ANGLE 把 `x + 0.0` 代数化简回 `x`（见 §4.3），canonicalize 改 select 形式。
  3. WebGL2 反馈环：FBO 附件纹理残留在采样单元 → drawArrays 报 GL_INVALID_OPERATION；
     绘制前必须把源纹理绑回采样单元（探针已内建防御）。
- 测试：`src/shaderCompute/hiZReduce.test.ts`（7 项：IR 校验/黄金文本与哈希/双模式同构/
  参考实现/输入生成）+ 真机对拍 `scripts/r2ShaderIrGpuTest.mjs`（`pnpm --filter
  @bim-studio/deep-engine test:r2-shader-ir-gpu`）：headless Chrome 153 内 WebGPU（Dawn,
  RTX 4060 Laptop）与 WebGL2（ANGLE→D3D11）真实执行，CPU 参考三方对拍，每案例跑两遍验证
  后端内重复稳定性；**逐位档判定 PASSED——四个案例三端输出哈希逐字节相同**；denormal
  案例双 GPU 彼此逐位一致、与 CPU 参考 flush 差异如实记录（阈值档）。
- 语义分歧声明：本切片 kernel 窗口为 2×2 锚定块；生产 `HI_Z_REDUCE_WGSL` 为变窗公式，
  NPOT 首档数值不逐位相同——收敛方案已列入 §5/§8，不冒充"已替换生产"。
- Native wgpu：**本切片未接**（与并行车道 cargo 目标锁/时序冲突风险），harness 合同与
  驱动桩留 `src/shaderCompute/nativeHarness.ts`（纯 TS 契约说明），WGSL 文本直用即可接。

## 7. 收敛路线（不另起炉灶的依据）

1. v1：IR op 扩展（window-range、buffer I/O、少量阈值档超越函数）+ flip 旗标 + 逐内核容差矩阵。
2. v1：把 `webgpu/hiZPyramid.ts`、探针 capture 的手写 WGSL 逐内核替换为 IR 生成（每换一个内核，
   旧 WGSL 与新 WGSL 在同一输入上做黄金对拍后才删除）。
3. v2：Native wgpu harness（Rust 侧单测：同 WGSL 文本 + 同输入 → 输出哈希回写 evidence.json），
   补齐"三后端"第三端；此后 Web/Native 双份手写 WGSL 按内核逐个退役。
4. 远期：DCIR 与 schema 1 共享节点词表与发射工具（`shader/` 与 `shaderCompute/` 合并为单一
   着色 IR 组），编辑器 DeepSL 可直接产出 compute 节点。

## 8. 剩余缺口（如实）

- Native 第三端未实测（仅 WGSL 文本共享承诺 + TS 侧桩）。
- GLSL 后端仅覆盖"可降级为 fragment 的 gather 型 kernel"；buffer 形态内核未覆盖。
- 生产 HiZ/探针内核尚未真正迁移（§5 是路线不是现状）。
- 阈值档 op（超越函数、fma）未实现，无 ULP 实测数据。
- 证据目录：`test-output/r2-shader-ir-20260919-r1/`（evidence.json + 各后端 shader 文本 + 输入/输出哈希）。
