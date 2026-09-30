# J2-B5 探针生产采样接缝与向量门

日期：2026-09-30。共享 storage 核与 Native 生产采样函数的共同 GPU 向量门已通过两端实际宿主验证；GI 语义与资源 ABI 保持原状，完整帧对拍仍留后续。

## 现状核查

| 六步 | 已有（不重建） | 真实缺口 |
|---|---|---|
| 全仓源码/未跟踪 | packages/apps 的 probeClipmap/probe_gi/deepGiSample 检索及 git status 已查。共享 WGSL、TS texture 核、Native mesh storage 核均在用或已登记；B4 和粒子等在途文件不触碰。 | 真源相同的字节证据没有覆盖实际生产采样消费。 |
| 契约 | ProbeClipmapLevel、IrradianceProbeRecord、96B record/64B level；Native ProbeGiGridHeader/v2 cascade 与96B record已存在。contracts 能力清单已有 probe GI。 | Native group0 binding11 的内嵌网格头记录流与共享 group3 bindings9/10 的分离 metadata 不同；不能直接拼绑定。 |
| 依赖 | esbuild、Vitest、@webgpu/types、Playwright/Chrome、wgpu30、pollster、serde_json 和 bytemuck已安装。 | 无需新 GI 库、IR 或平台。 |
| 消费 | TS pbrShader.ts实际导入 PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL，fragment调用deepGiSampleTexture；Native frame_bindings factory拼native_mesh_v1.wgsl，fragment调用probe_gi_irradiance→grid/nearest。 | Rust probe_gi_wgsl.rs只有include/checksum测试，没有生产factory消费；共享storage核不是当前TS PBR或Native采样核。 |
| 测试/证据 | TS storage CPU、checksum、texture WGSL与T02真GPU门已有；Native probe_gi_grid参考/级联与renderer/probe_gi_gpu_tests.rs真实帧已有。 | 现有Native帧门用均匀辐照度，不能揭示非均匀权重/重定位/可见性漂移；没有共同数值fixture与实际函数身份。 |
| 规格/交接 | J2-B5剩余项、0930handoff、F5单源试点报告及T02实现记录已查。 | F5报告证明共享字节，不等于实际生产核已单源；不重建32方向捕获、失效/收敛或GI调度。 |

## 保留的语义差异

storage共享核/CPU参考以原worldPosition计算三线性权重，法线偏移只用于Chebyshev可见性；Native grid核同式，但网格max为origin+gridSize*spacing，共享TS metadata为origin+(gridSize−1)*spacing。共同输入仅取交集，域外点置于两端外。

TS生产texture核以法线偏移后的receiver计算三线性权重；不携带距离方差、occlusionFloor或relocation；级联混合采用线性clamp，storage/native采用smoothstep；texture fine/coarse有效性和极小权重处理也不同。这些差异不能用完整三族等价断言掩盖。Native非法normal返回零，共享核非法normal回退+y；本刀只取有效有限输入。

## 最小切片

共同fixture冻结两个2³层、逐探针非均匀RGB、有限法线、层间混合、细层失效粗层兜底、Chebyshev及重定位。TS正式record/level packer上传共享核；Native正式网格头编码/96B record上传生产grid函数。GPU值分别对CPU参考、跨宿主数值，SHA-256绑定实际执行函数；重复两轮。Native既有帧GPU门另跑，避免将向量核声称为完整场景渲染。

所有生产WGSL、ABI和同步器保持原状。新增fixture/lab/runner及Native定向GPU测试，沿用现有readback helper。执行结果在后续小节记录。

## 实施与验证

新增八文件：本规格、`fixtures/j2-probe-gi-v1.json`、`lab/j2ProbeGiGpuProbe.ts`、根 `scripts/j2-probe-gi-parity.mjs`、`scripts/lib/j2ProbeGiNativeRun.mjs`及其Node测试、Native `tests/j2_probe_gi_parity.rs` 和 `tests/support/j2_probe_gi_gpu.rs`。Native测试直接引用生产hash模块、使用正式ProbeGiGridLayoutHeader/ProbeGiGridHeader编码和IrradianceProbeRecord校验；读回复用既有`lod_draw_readback.rs`。生产文件没有修改。

十种输入：非均匀RGB层间混合、边缘斜法线、细层边界、仅粗层、两端域外、零法线、反向法线、Chebyshev可见性、探针重定位、细层失效粗层兜底。环境fallback固定零；没有把非法normal的既有差异混入共同合法域。

Chrome检查命令：`node scripts/j2-probe-gi-parity.mjs --chrome-only`。NVIDIA Lovelace上两族×十输入×两轮全部通过，CPU参考最大误差`6.307022742957358e-8`，两轮稳定。两张`test-output/interrupted-0930/probe-gi-parity/round-{1,2}.png`已检查，文字与数值完整，无裁切。夹具使用已有base.css令牌，属于数值检查页面，不是完整产品场景的Kimi-95验收。

| 身份 | SHA-256 |
|---|---|
| 共同fixture实际UTF-8字节 | `35f220756268a3abab238d2c4f6b87dbd565a1acdf0e4a0126107aadb6ec26c3` |
| shared-storage实际执行shader | `36d1fb76611815357a2b6e93eef7f219f4b5c6334b8aac8dda72910b381028d8` |
| native-production-storage实际执行shader | `cbaf5a53f2cb33459d2630b247a1a82665fa997a1cbd1e4db8623295141f42f8` |

Native真GPU由主线串行运行：

```text
node scripts/j2-probe-gi-parity.mjs
```

默认runner首先删除旧native.json/evidence.json，执行本次`cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --test j2_probe_gi_parity -- --ignored --nocapture`，确认命名GPU测试实际通过和非零passed总结，要求新JSON包含完整十情景、两轮、有限值及成功状态，再执行Chrome并比身份/数值。Native失败、空过滤、漏写JSON或不完整样本均报错并删除Native/evidence结果。Cargo日志保存为`test-output/interrupted-0930/probe-gi-parity/native.log`，默认模式由主线串行执行。

`--chrome-only`仅运行Chrome；`--compare`或`--offline`保留历史Native JSON进行当前Chrome数值比较，证据明确标注“Native host not executed this run”、`nativeRunFresh=false`。只有默认本次双端运行记录`nativeRunFresh=true`。历史比较不得作为本次Native宿主验收。

Native RTX 4060 Laptop / Vulkan实测：1 GPU test passed，十情景各执行两轮，重复值精确一致；CPU f32参考最大误差`1.1920928955078125e-7`，耗时0.74s。日志`test-output/interrupted-0930/probe-gi-native.log`。默认Chrome+Native runner结果`passed=true`、`stable=true`、`identityMatched=true`；十情景跨宿主最大差`5.960464477539063e-8`，容差`1e-5`。最终合并证据`test-output/interrupted-0930/probe-gi-parity/evidence.json`。

TS focused回归：`probeClipmapSampling.test.ts`、`probeClipmapSamplingWgslChecksum.test.ts`、`probeClipmapTextureSamplingWgsl.test.ts`，15 passed、2个既有Naga环境条件skipped；lab类型检查通过。Native首编译暴露测试对私有hash模块的导入错误，已改为`#[path]`复用同一生产源，复跑通过，生产API不变。新增代码均低于300行；source-size检查当时唯一失败为另一线路的author_grading_gpu.rs，由主线处理。

独立审查发现首版runner只读Native JSON会接受失败测试后的旧成功证据，已按上述默认运行规则修正。`node --test scripts/lib/j2ProbeGiNativeRun.test.mjs`：5 passed，覆盖旧证据+Cargo失败、空测试、未生成新文件、不完整样本及成功实际命名测试；JS语法检查通过。独立只读复核确认此P2关闭。主线修复后默认runner重跑通过，最终证据`passed=true`、`stable=true`、`identityMatched=true`、`nativeRunFresh=true`；sourceSizeGate failures=0。

## 后续范围

本刀测生产Native函数和已有共享storage核的有限输入数值。Web真实PBR texture采样、Native完整帧与Web相同场景HDR对拍、动态GI收敛/漏光产品视觉、帧时、共享核生产适配仍留后续。Native既有`probe_grid_trilinear_adds_uniform_ambient_on_real_gpu`及`probe_grid_two_level_cascade_on_real_gpu`可复用作生产帧证据，测试会在缺少ray-query设备时返回，验收必须确认实际GPU运行而非仅看passed。
