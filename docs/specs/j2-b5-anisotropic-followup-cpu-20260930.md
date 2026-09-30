# J2-B5 非均匀 storage/biased texture 后继（CPU 侧 + 独立 oracle）

B5 uniform 生产 GI 已验（双端各两 fresh、2040 点、.001 门过）后，交接明示"仅只读研究，没有新增实现"，
并给出候选方案。本文冻结该候选的规格，并完成 CPU 侧实现（fixture/lab/identity/runner）。
GPU 实测由 root 统一串行执行，本刀不运行 Cargo/GPU、不写 Native Rust 支持文件（那是 root 接线）。

## 现状核查（六步，2026-09-30）

1. **全仓 grep**：`aniso|anisotropic` 在 packages/apps/scripts/docs 全查，命中的全是大气/雾散射的
   各向异性（atmosphereSky、volumetricFog），与 probe GI 无关；`非均匀` 在 J2 域内只命中
   `j2-b5-shared-storage-production-adapter-20260930.md`（"结果边界仍为 uniform……非均匀三线性另有后继"）
   与 `j2-b5-probe-production-parity-20260930.md`（十向量 = CPU storage 共同核，非实帧）。
   git 未跟踪文件中 J2 系列即 B5 已验参照，无任何 aniso 实现文件。**无重复建设对象。**
2. **契约**：`ProbeClipmapLevel`（probeClipmapPlan.ts）、256B metadata packer `packProbeLevels`
   （probeClipmapResourceData.ts）、96B `IrradianceProbeRecord` 与正式 CPU sampler
   `sampleIrradianceProbeClipmap`（probeClipmapSampling.ts）、canonical storage WGSL
   （probeClipmapSampling.wgsl，group3 bindings9/10）、texture WGSL
   （probeClipmapTextureSamplingWgsl.ts，binding9 texture_2d_array / 10 sampler / 11 uniform256B）
   全部已存在。**类型与 ABI 无需新增。**
3. **依赖**：deep-engine 已有 vitest/esbuild/@webgpu/types（B5 消费中）；scripts 侧 node:test 与
   runner 所需 esbuild/playwright-core 均按 B5 同路径引用。**不新增任何依赖。**
4. **消费方**：`sampleIrradianceProbeClipmap` 被 lab/j2ProbeGiActual.ts（B5 CPU admission）与
   lighting 测试矩阵消费；`deepGiSampleTexture` 被 pbrShader.ts 正式消费（GI.rgb，alpha 门）。
   本刀新增独立消费（aniso lab/identity/runner），不改任何既有消费点。
5. **测试证据**：`test-output/interrupted-0930/probe-gi-actual/` 有 B5 完整双端证据
   （evidence.json 2040 点/3060 区间、native.json 2 fresh runs、web-0/1.json、cpu-plan.json、
   storage-conversion/ 独立 witness）。85 点几何实查：全部在 z=0 平面、法线 [0,0,1]、
   base [0.86,0.28,0.055]、x∈[0.88,1.33]、y∈[-0.87,0.70]、两相机 45+40。
6. **规格**：B5 规格末段与实帧段落明示缺口就是"非均匀三线性/biased texture 差异展示"；
   原 [-24]^3 uniform 共同输入因 z 权重归一化抵消无法展示该差异，原 [-16,-16,-16] grid-plane
   是 native 全 85 点 fallback 的负控制。**真实缺口 = 非均匀逐 probe 输入下两族各自独立 oracle 的
   CPU 冻结与 CPU 门；GPU 侧与 Rust 支持留给 root。**

**已有（不重建）**：uniform 实帧矩阵、CPU storage sampler 与十向量共同核、binary16 反解区间门、
storage-conversion witness、packet/上传/帧身份门、B5 全部已验 11 文件（只读参照，本刀零修改）。
**真实缺口（本刀新增）**：非均匀 z 分层输入 fixture、两族独立 HDR oracle 的 CPU 冻结、
z 单元差异可展示性证明、aniso 身份门（含 input 哈希 stale 拒绝）、runner prepare/GPU 入口。

## 候选场景冻结（论证）

交接候选 `[origin=[-16,-16,-15], spacing=16, gridSize=[3,3,3], +Z 平面原 85 点, bias .2,
half 精确 irradiance, .001 门]`，全部沿用 B5 已验的合法共同输入：

- **几何**：85 点/2 相机/128×128/两 draw，与 B5 逐字节同一 cpu-plan 推导（同一 manifest
  `j3-hdr-flat-normal-v1`、同一 runtime-package）。点集与 B5 完全相同，不改任何采样点。
- **两族域内**：Native 域上界 origin+gridSize·spacing=[32,32,33]；Web metadata 域
  origin+(gridSize-1)·spacing=[16,16,17]。85 点 x∈[0.88,1.33]、y∈[-0.87,0.70]、z=0，
  在两族域内（Web 更紧，仍全内）。内部检查沿用 B5：origin+0.2·spacing ≤ p ≤ origin+1.8·spacing。
- **正权重**：CPU 复算（B5 同一 admission 数学：8-corner trilinear × max(cos,0)^3，
  cosine 用原始着色点；Web 家族仅三线性坐标 +normal·0.2·spacing 偏移）：

  | 家族 | 85 点最小 admission（f64 复算） | 交接值 | 偏差 |
  |---|---|---|---|
  | Native | 0.124196721（axis/9811） | 0.12419672 | 5.6e-10（8 位舍入一致） |
  | Web | 0.239686631（axis/9811） | 0.23968663 | 1.5e-9（8 位舍入一致） |

  全部 85 点 native≥.001 且 web>0。复算与交接一致，交叉核对写进 lab 测试（常量
  `HANDOVER_ADMISSION`），漂移即红。
- **z 单元差异可展示（本候选的核心增量）**：z=0 点在 native 坐标 z=(0+15)/16=0.9375，
  单元集合 {0,1}（probe z=-15/1）；Web biased receiver z=3.2 → 坐标 1.1375，单元集合 {1,2}
  （probe z=1/17）。probe z=-15 位于平面下方，法线权重 cos<0 归零（合法 DDGI 语义），
  故 **Native storage 有效单元为 {1}，Web biased texture 有效单元为 {1,2}**——两族采样的
  z 单元集合合法不同，正是 B5 uniform 输入无法展示、而本候选可展示的差异。
- **非均匀输入（z 层梯度 + xy 棋盘，均为 2 的幂 half 精确）**：
  - `zero`：全 [0,0,0]（负控制：两族 HDR=0，延续 B5 zero/mode0 控制）。
  - `z-ramp`：z 单元 0/1/2 分别为 [0.25,.5,1] / [.5,1,2] / [1,2,4]。
    Native 期望=z1 层常量 [.5,1,2]（z0 层被法线权重合法归零、z1 层 xy 四 probe 同 RGB 归一化）；
    Web 期望=[.5,1,2] 与 [1,2,4] 按 fraction 0.1375 与法线权重的正混合（逐点 CPU 精确算，
    与 [.5,1,2] 偏差 ~0.1 量级，远超数值噪声）。uniform 抵消负证：同场景改全 [.5,1,2] 时
    两族采样均归一化回 [.5,1,2]，证明差异确实来自非均匀输入而非坐标差。
  - `checker`：cell (x+y+z) 偶 [0.25,.5,1] / 奇 [1,2,4]（逐 probe 交替，交接候选第二形态）。
  所有 RGB 值 ∈{0,0.25,0.5,1,2,4}，binary16 精确（half bits 0x0000/0x3400/0x3800/0x3c00/
  0x4000/0x4200），Web half texture 与 Native f32 storage 承载同一数学值；validity=1、
  meanDistance=100000、variance=1、relocation=0 沿用 B5。
- **bias/irradiance/门**：normalBiasCells .2、metallic 0、roughness .8、DFG [.75,.0625]、
  dielectric .04、绝对 half 门 .001 全部沿用 B5 冻结值，不重开。

## 独立 oracle 设计

同 B5 先例：**两族完整 HDR 公式差异保留，各自冻结独立期望，不要求裸 HDR 相同。**

- **Native storage oracle**：正式 CPU sampler `sampleIrradianceProbeClipmap`（canonical 镜像，
  worldPosition 三线性 + validity + Chebyshev + 法线权重 + .001 门）逐点采样 27 条按 cell
  非均匀的 records；HDR 期望 = base · sampledIrradiance / PI。sampler fallback 或
  accumulatedWeight<.001 即 CPU 拒绝。
- **Web biased texture oracle**：lab 内独立 CPU mirror（严格对齐
  probeClipmapTextureSamplingWgsl 语义：receiver=world+normal·0.2·spacing 的三线性坐标、
  8 次 textureLoad（layer=cell.z）、trilinear×validity×法线权重（原始着色点）、累计权重>0
  即有效 alpha=1；无 Chebyshev——texture 路径不发明距离统计）；HDR 期望 =
  base · sampledRGB · (1-specularFraction)，specularFraction 同 B5 解析式。
- **比较**：每族逐点逐通道 |GPU HDR − CPU 期望| ≤ .001（B5 绝对 half 门沿用）；
  z-ramp/checker 每点期望>0 且实测>0（正增量）；zero 期望=0。两族不做裸 HDR 对拍；
  B5 的 uniform 反解区间交叉门（compareProbeSamplingIntervals）依赖共同标量期望，
  **非均匀下不适用，本刀不引入、不伪造**，差异在此明示。

## 语言与格式规范链接（与 B5 同记法，语言转换与 RT 格式转换分开）

- [WGSL 15.7.6 浮点转换](https://www.w3.org/TR/WGSL/#floating-point-conversion)：非精确转换
  允许夹住相邻可表示值——属语言求值/转换规则。
- [WGSL 15.7.2 浮点求值](https://www.w3.org/TR/WGSL/#floating-point-evaluation)：未指定统一
  舍入模式——属语言求值规则。
- [WebGPU plain color formats](https://www.w3.org/TR/webgpu/#plain-color-formats)：定义
  rgba16float 附件格式，不提供 RTNE 附件存储保证——属 RT 格式转换合同。
- [Direct3D 11.3 §3.2.2](https://microsoft.github.io/DirectX-Specs/d3d/archive/D3D11_3_FunctionalSpec.htm#3.2.2)：
  高精度转低精度格式用 RTZ——仅按 Direct3D 范围引用，不推及 Native 后端。
- 本刀期望为 f64 CPU 值 + .001 绝对门，门宽已覆盖 B5 实测 f32/存储舍入量级
  （Native 3.2e-5 / Web 2.1e-4），无需新假设；RTNE/RTZ 差异仍由既有 storage-conversion
  witness 承担，不在本刀重复。

## CPU 交付物与门

全部新文件，零修改既有文件：

1. `packages/deep-engine/fixtures/j2-probe-gi-aniso-v1.json` —— 上述冻结场景。
2. `packages/deep-engine/lab/j2ProbeGiAnisoFixture.ts(+test)` —— fixture 类型、
   B5 同数学独立几何 admission（含交接值交叉核对）、两族期望（storage 正式 sampler /
   texture 独立 mirror）、z 单元可展示性证明（含 uniform 抵消负证）、Web GPU 采集函数
   （与 runProbeActual 同构，入口备好、本刀不执行）。
3. `scripts/lib/j2ProbeAnisoIdentity.mjs(+test)` —— 身份/上传/帧门（对齐 B5 结构），
   逐 cell RGB 断言、input 哈希与冻结字段携带、stale 拒绝；负例：错 origin / 错门 /
   证据过期必须 FAIL。
4. `scripts/j2-probe-gi-aniso.mjs` —— runner：`--prepare` 写 input 哈希+CPU 检查（现在可跑）；
   完整 GPU 入口（Native spawn + Web 两 fresh playwright + 比较）写好但不执行。

CPU 验证命令（全部已跑通，见交付报告）：

```
cd packages/deep-engine && pnpm exec tsc --noEmit -p tsconfig.lab.json
cd packages/deep-engine && pnpm exec vitest run lab/j2ProbeGiAnisoFixture.test.ts
node --test scripts/lib/j2ProbeAnisoIdentity.test.mjs
node scripts/j2-probe-gi-aniso.mjs --prepare
```

## GPU 验证留给主线程的精确命令（本刀未执行，不做任何通过声明）

前置（root）：新增 `packages/deep-engine-native/tests/support/j2_probe_gi_aniso.rs`
（对齐 `j2_probe_gi_actual.rs`：同 configure/IBL/85 点，records 按 cell 非均匀写入，
期望 `base·sampled/PI` 逐点）并在 `gpu_shader_material_draw.rs` 挂接具名测试
`j2_b5_aniso_probe_gi`；Web 采集由 runner 直接驱动 lab 的 `runProbeAniso`。

1. `node scripts/j2-probe-gi-aniso.mjs --prepare`（CPU 前置，已可跑）
2. `cd packages/deep-engine-native && cargo test --test gpu_shader_material_draw j2_b5_aniso_probe_gi -- --ignored --nocapture`（Native 两 fresh 设备，写 `test-output/interrupted-0930/probe-gi-aniso/native.json`）
3. `node scripts/j2-probe-gi-aniso.mjs`（统一 fresh：再跑 Native 具名一次 + Web 两 fresh 采集 + 双端比较，写 evidence.json；失败清本次汇总）
4. 分段复跑：`node scripts/j2-probe-gi-aniso.mjs --compare`（仅已有证据诊断，currentRun=false）

## 边界与未做（诚实条款）

- **未做**：init producer、capture commit、动态漏光、完整 B5、Native Rust 支持文件、
  全部 GPU 实测——均不在本刀范围或由 root 串行执行。
- **风险**：lab 的 `runProbeAniso` 与 runner GPU 入口仅经 tsc/结构对拍，未过浏览器运行
  （诚实声明：GPU 路径未验证）；Native Rust 期望逐点用 CPU sampler 推导，root 接线时若
  f32 舍入超 .001 门（B5 实测量级远低于门，风险低）需回填证据而非放宽门。
- 本刀不宣称：非均匀生产 GI 已验；两族裸 HDR 等价；capture/producer 覆盖。
