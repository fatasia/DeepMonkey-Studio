# F5 方向修复方案 A 实施 — 96B reserved 启用 RGB L1 SH 方向可见度（2026-10-03）

> 底座：`docs/specs/f5-directional-design-proposal-20261003.md`（用户已批准，方案 A）。
> 本刀 = 实施刀。禁 cargo（native 只改声明字面量/文档）；禁帧时测量；不 commit/push。
> 验收门（用户确认）：intFloorBack leakRatio ≤1.1（32 方向 CPU 参考）+ 白炉逐位负控
> + Chebyshev 方向性验证。每节完成即落盘。

## 0. 现状核查（六步，含未跟踪）

1. **全仓 grep**：`probeSpecularEnvironmentVisibility` 仅存于 deprecated TS 反例模块及其
   测试；**生产 shader 已无任何镜面探针门**（f5-final-webgpu-verification §2.2/2.3 撤销了
   variant-semantics 的亮度比乘子）。`reserved`/`words[12..23]` 消费点：pack 全零、
   storage WGSL `reserved0/1/2`、native `probe_gi_abi.rs`（validate 要求全零）。
2. **契约层**：`DEEP_GI_PROBE_RECORD_BYTES=96`（probeClipmapPlan.ts:84）；
   `packIrradianceProbeRecord` words[7]/[11] 空槽、[12..23] 全零在案；
   `probeNativeAbiGolden.test.ts` 钉 words[12..23]=0 金样。
3. **依赖**：零新增依赖；naga（`~/.cargo/bin/naga.exe`）在位（二进制校验 ≠ cargo）。
4. **消费方**：
   - 捕获：`probeRadianceKernel.ts`（`PROBE_RADIANCE_MAX_DIRECTIONS=32`，方向表 CPU 权威
     `probeOcclusionDirection`；`visibilityMoments` 变体已产出 raw moments rgba32float
     (mean/var/miss/valid)）；`ProbeSceneRadianceProducer` b10 moments 管线在案。
   - 发布：`WebGpuProbeMomentsPipeline`（real-moments 刀交付：publish 写 record
     irradianceValidity/visibility + 发布 fragment b16；`probeMomentsVolumeSize` 每探针 1 texel）。
   - 采样/着色：`deepGiSampleTexture`（rgba16float 体积 + b16 moments，8-tap DDGI 权重）
     → `pbrShader.shade()` IBL 块漫射 `mix(envIrr, gi.rgb, gi.a)`；镜面项
     `radiance * specularFraction * occlusion * frame.eye.w` 无探针感知。
5. **测试与证据**：`probeRecordIrradianceSemantics.test.ts`（E(n)=πL(1+n_y)/2 oracle 5 例，
   **不得回归**——本刀只修镜面方向消费，漫射 mix 语义不动）；`probeSpecularEnvironmentVisibility.test.ts`
   7 反例钉「生产无乘子」（本刀按批准设计切换为新合同，须同步更新其生产面断言）；
   `probeLeakDirectionMatrix`（矩阵口径）+ f5-fix-metrics leakRatio 尺
   `sealedDelta.R/max(openDelta.R,0.01)`（不改尺，CPU 复刻同一口径）。
6. **规格**：f5-directional-design-proposal（批准）、f5-final-webgpu-verification（撤销归因
   与物理审查）、f5-real-moments-consumption（moments 发布链 + 片元 15/16 纹理、8/8 storage
   饱和事实）、jc-i-continuation（只读）。

### 已有（不重建）

- 32 方向捕获核 + Fibonacci CPU 权威方向集 + 命中点阴影射线（F5-GI-1b）。
- moments 发布链（raw/output rgba32float 体积、clear/publish 管线、事务/池/回滚）。
- 96B record pack/金样/native ABI 结构、DDGI 8-tap 采样（CPU/WGSL/RS 三端同式）。
- CPU 参考域：`buildReferenceRoomScene`（薄墙+门洞+天窗）、
  `evaluateProbeRadianceWithDirections`（功能量唯一实现点）、`sampleIrradianceProbeClipmap`。

### 真实缺口（本刀）

- words[12..23] 无语义：无投影实现、无消费、native 声明「必须为零」。
- 镜面 IBL 零探针感知（标量门已被物理审查撤销；本刀按批准设计以 L1 方向门为主、
  标量门仅在 SH 缺失探针上作 fallback 重建）。
- SH 到 fragment 无通道：片元纹理 16/16、storage 8/8 上限饱和（real-moments 刀实证），
  **不可新增绑定** → moments 体积按 lane×4 扩展是唯一不抬 device limits 的通道。
- intFloorBack ≤1.1 CPU 验收、白炉逐位负控、方向性验证三件套不存在。

## 1. 语义定案（合同）

### 1.1 块布局（channel-major，零 stride 变更）

words[12..23] = 12 f32 = RGB L1 SH 方向可见度，**每通道一个 vec4**：

| words | 内容 |
|---|---|
| 12..15 | R 通道 (c_l0, c_l1m-1, c_l1m0, c_l1m1) |
| 16..19 | G 通道同序 |
| 20..23 | B 通道同序 |

与 storage WGSL `DeepGiProbeRecord.reserved0/1/2` 逐字对位；生成文件不改名不改字节门禁，
语义升级由本规格 + manifest + 金样三方声明。

### 1.2 投影（白炉逐位负控的构造性保证）

对探针 32 方向既有射线的**每方向贡献** `s_i`（= 捕获均值 summand：命中 Lambert 一跳或
miss 环境，与既有 `sum` 同值同序）：

- `c0[ch] = (Σ_i s_i[ch]) / N`（与捕获均值同式同序 → 白炉下与 capture RGB 逐位同源）；
- `d_axis[ch] = (3/N) · Σ_i (s_i[ch] − c0[ch]) · dir_i[axis]`（等权 LSQ，unnormalized 轴基，
  与 Frame deepDiffuse 64B eval 同族；系数序 l0, m-1(y), m0(z), m1(x)）；
- 重建 `recon(dir)[ch] = c0[ch] + d_y·dir.y + d_z·dir.z + d_x·dir.x`。

**白炉不变性（构造级）**：均匀场时 `s_i ≡ c0`（32 个同值 f32 求和/除 32 精确无舍入），
`d ≡ 0.0` 精确 → `recon(dir) ≡ c0`，`gate = clamp(c0/c0,0,1) = 1.0` 精确 →
`radiance * 1.0 * …` 与现版本逐位同。CPU/WGSL 同式同序。

### 1.3 消费（镜面方向门 + 标量 fallback）

- `gate = clamp(luma(recon(reflect(-view,n))) / luma(envIrr), 0, 1)`，Rec.709 luma；
- 保守三分支不变：探针域外恒 1；env 近黑（≤1e-4）恒 1；其余线性；
- **SH 缺失探针（12 字全零）→ fallback 标量门** `clamp(luma(probeRgb)/luma(env),0,1)`
  （f5-variant-semantics 裁定式，批准降级为 fallback；其「暗 albedo vs 遮挡不可辨识」
  物理局限如实保留，见 §6 未验证项）；
- 8-tap 权重（trilinear × validity × Chebyshev × 法线）与漫射采样完全同款，
  门按权重混合 `Σw·gate_i / Σw`；级联 mix(fine, coarse, blend) 同款。

### 1.4 生命周期

随 capture→publish 同周期：kernel 累计 SH → raw moments lane1..3 → publish 写
record reserved + output lane1..3 → fragment b16 读。**零新增绑定槽**（capture 核仍
8 storage + b8/b10 两 storage texture；publish 管线绑定集不变；fragment 纹理/存储数不变）。
moments 体积 lane×4（每探针 64B，6144 探针 = 384KB 量级，内部 transient 池预算公式同步）。
旧 1-lane moments 体积对新 shader `realMoments=false` → 整体安全降级为旧行为。

## 2. 改动清单（文件级）

| 文件 | 内容 |
|---|---|
| `lighting/probeDirectionalVisibilitySh.ts` | **新增**：投影/重建/门 CPU 参考 + words 布局常量 + record pack/unpack |
| `lighting/probeClipmapSampling.ts` | `IrradianceProbeRecord.directionalVisibilitySh?` → words[12..23]；`recordFinite` 扩展 |
| `lighting/probeReferenceIntegrator.ts` | `evaluateProbeRadianceWithDirections` 可选 `withDirectionSamples`（默认零行为变化） |
| `rayTracing/probeRadianceKernel.ts` | moments 变体：per-direction 采样数组 + SH 累计 + raw lanes1..3 写出；`PROBE_RADIANCE_MOMENT_LANES=4` |
| `webgpu/webgpuProbeMoments.ts` | 体积 lane×4；publish 读写 lanes + record reserved 写出 |
| `lighting/probeClipmapTextureSamplingWgsl.ts` | `DEEP_GI_MOMENT_LANE_COUNT=4`；realMoments lane 判据；`deepGiSpecularDirectionalVisibility` |
| `webgpu/pbrShader.ts` | 镜面项乘 `deepGiSpecularDirectionalVisibility(world,n,reflection,envIrr)` |
| `webgpu/rendererCapabilitySelfCheck.ts` + contracts manifest + fixture JSON | `gi-probe-directions` 行 observed/证据扩展（声明 words[12..23] 启用） |
| `deep-engine-native/src/probe_gi_abi.rs` | reserved 声明字面量/文档更新（不改 validate 行为，禁 cargo） |
| 测试 | 新 `probeDirectionalVisibilitySh.test.ts`（白炉逐位/方向性/ pack 往返/门分支）+ 新 intFloorBack 32 方向 CPU 对拍 + 金样/采样/producer/pbrShader 断言同步 |

## 3. 验收门执行（本机实测读数）

1. **白炉逐位负控**：均匀场 → dipoles 全零 `toBe(0)`、gate `toBe(1)`、`radiance*1.0`
   逐位恒等（IEEE754 ×1.0 精确）；CPU/WGSL 同式同序，naga 解析+语义校验过。
2. **intFloorBack ≤1.1**（`probeDirectionalLeakGate.test.ts`，参考房间 CPU 场景、32
   Fibonacci 方向、shadowed 真值 + 两遍反弹、9×2×7 探针格、12 后段地板接收点）：
   - 原尺逐字：`leakRatio = sealedDelta.R/max(openDelta.R, 0.01) = -1.430 ≤ 1.1` ✓，
     且封门贡献 ≤ 开间贡献 ×1.1 ✓。
   - **如实登记**：本时代（F5-GI-1b 后、无漫射漏光）sealed/open delta 同为负
     （-0.0143 / -0.0135）——残余漏光是「绝对镜面误差」通道（无门时镜面项与 GI-off
     相同、不可见于 delta 尺），与 GPU 末轮负比值定性一致；≤1.1 按批准门逐字保留，
     非退化判据由下列正控承载。
   - 亮环境（捕获/显示同一套天空，L4 量纲一致合同）：无门封门后段镜面 = 全天空
     0.05，门后 **< 1e-7（抑制 ≥10⁷×）**；backGateMax = 0.0000（封门天花方向门全闭）。
   - 场景环境量纲：天窗亮斑地板 gate = 1.0000（开阔方向零扰动）。
3. **方向性验证（Chebyshev 同族）**：合成半球场（上半球 1 / 下半球 0）→ recon(UP) > 0.75、
   recon(DOWN) < 0.25；标量门对上/下半球给出同值（对照在案），L1 门 gateUp > scalar >
   gateDown（单调分辨上/下半球）。
4. **锐度上限（如实登记，方案 B 叠加项）**：1.5×2 天窗开口 @2.5m ≈ 球面 2.5% 的亚格
   锐开口在 32 方向 Fibonacci + 盒边界 + L1 三重分辨率下不可分辨（近 Up 两条 Fibonacci
   射线恰好命中开口边界；skylight 诊断读数 0.17 不设断言）——半球尺度方向差（本刀
   靶点）L1 足以表达，镜面级锐阴影按设计 §2 风险条留方案 B（方向 atlas）叠加，不堵。

## 4. 诚实边界（申报）

- 真机 GPU 像素门（原 sealed 三域冻结序列）本刀不跑（GPU 窗口归主线程）；CPU 参考门
  即用户确认的验收口径。
- fallback 标量门保留「暗 albedo × 无遮挡 ≡ 白 albedo × 遮挡」不可辨识局限（批准设计
  的已知代价）；L1 方向门的主路径在 l0 项上同样携带该局限，方向项只修**方向差**，
  不修复辐射可辨识性（f5-final §2.2 审查在案）。
- L1 方向锐度有限（设计 §2 风险条，本刀已定量：亚格锐开口 gate≈0.17）；镜面级锐阴影
  不足时按方案 B 叠加。
- 帧时未测（禁令）；+24 次 textureLoad/片元（8-tap × 3 SH lane）为最坏情况静态事实。

## 5. 测试证据（本机实测，2026-10-03）

- 新增/更新：`probeDirectionalVisibilitySh.test.ts` 4/4、`probeDirectionalLeakGate.test.ts`
  3/3、`probeNativeAbiGolden.test.ts` 3/3、`probeClipmapTextureSamplingWgsl.test.ts` 3/3
  （含 naga）、`probeSpecularEnvironmentVisibility.test.ts` 7/7、
  `probeSceneRadianceProducer.test.ts` 全绿（含 naga moments 变体）。
- 家族（naga 开启）：lighting+rayTracing+threeBridge = **1108 passed / 1 failed**；
  webgpu = **1850 passed / 5 failed**。失败逐项定性，全部并行在途域、无一由本刀引入：
  1. `iesSamplingWgslChecksum.test.ts`（TS 镜像 vs `wgsl/iesSampling.wgsl` 字节对拍）——
     该共享源文件被并行写者改动 166 行（LTC 内核再次误追加，d16a66c1 曾修过同形错误），
     镜像再生成归该线，与照明探针域零交集；
  2. `pbrPipelineSet.test.ts` ×3 + `pbrGodRaysIntegration.test.ts` ×2——并行写者把
     `contactShadows` 默认 false→true（manifest 在途 diff 同源），`writeGeometry` 断言
     跟随翻转，属特性默认值收口面。
- lab：c8 求导消融域 27 failed（并行在途 c8 文件，与本刀模块零导入耦合）；lab tsc exit 0。
- src/lab typecheck exit 0；被撤销函数/全域乘子的负控钉（`not.toContain`）全部保持。
- 真机 GPU 像素门（原 sealed 三域冻结序列）未跑（GPU 窗口归主线程）；CPU 三件套即
  用户确认的验收口径。禁 cargo 遵守：native 只改 `probe_gi_abi.rs` 声明字面量/文档，
  未编译未跑测试；validate() 行为零变更（全零=SH 缺失过渡语义在案）。
