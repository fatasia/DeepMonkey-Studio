# J2-B4 Native共同输入与linear PCF边界

日期：2026-09-30。补Native真实宿主的共同七点及生产linear comparison sampler边缘数值门；现有共享混合核、ABI及采样函数不改。

## 现状核查

| 六步 | 已有（不重建） | 真实缺口 |
|---|---|---|
| 源码/未跟踪 | 已检索packages/apps CSM/PCF/linear以及当前git status。三个生产CSM函数与共享cascadedShadowMath已在用；lab/j2CsmBoundaryGpuProbe已真实运行三族，原runner完整。 | 旧probe固定nearest及恒定层深度，无法区分linear filtering是否真实生效。 |
| 契约 | TS624B/最多8级、DeepSL/Native336B/最多4级采样uniform存在，共同两级输入可复用。 | 七个viewDepth现硬编码在lab，需提升为共同fixture，避免Native另抄一份漂移。 |
| 依赖 | esbuild/Chrome/Playwright、wgpu30/pollster/serde_json、真实depth-array fixture与RGBA32F staging读回已存在。 | 无新IR、无生产依赖、无需新GPU宿主平台。 |
| 消费 | Native ShadowMap生产sampler为ClampToEdge/linear/lessEqual；三族production函数均textureSampleCompareLevel作真实3×3 PCF。 | Chrome跑Native WGSL不等于Native wgpu宿主；原Native Player回归不使用共同七点。 |
| 测试/证据 | 既有Chrome三族7点×2宽度×2轮、Native CSM计划8测试、生产Player/CSM实际GPU回归均已过。 | 缺非恒定depth edge上的CPU独立bilinear oracle、Native共同输入GPU及实际sampler过滤差异负例。 |
| 规格 | 已读j2-b4-current-state及最新共享核/剩余任务/交接/恢复台账。 | 仅补linear+Native共同七点；跨设备全面性与完整CSM场景画质仍未测。 |

## 最小范围与预注册

复用原viewDepth七点`1,1.8,1.9,2,2.1,4,4.1`与blendStart`1.8,2`，固定4×4两层depth-array、receiverDepth0.5及相同uniform投影。共同fixture增加恒定层深度及左右半区深度互换的edge模式，UV x用七个子texel位置，y固定0.5；nearest与linear都实际采样。CPU oracle独立计算lessEqual比较后的bilinear+ClampToEdge+3×3 PCF及混合，不复用GPU结果当期望。

Chrome继续消费既有三个生产函数，Native复用既有cascaded_shadow测试target登记真实生产Native CSM源码读回；不替换sampler/filter、不新绘制场景renderer。每族/每端两轮应稳定、有限，CPU参考与跨宿主最大误差≤2e-6，数据/实际source hash必须匹配。真实edge fixture的linear与nearest输出必须出现显著差异，nearest结果冒充linear期望须失败。

仅一台RTX4060的两个API宿主，不能据此写成跨设备完成。不改生产性能路径，因此不开GPU帧时benchmark；18→9旧源码计数仍非实测性能收益。

## 拟锁

既有`lab/j2CsmBoundaryGpuProbe.ts`仅新增可选共同fixture模式，原nearest常量默认行为保持；`native/tests/cascaded_shadow.rs`仅登记新support；新`fixtures/j2-csm-parity-v1.json`、`lab/j2CsmBoundaryFixture.ts`（oracle/共同类型）、`native/tests/support/j2_csm_linear.rs`及必要小readback模块、`scripts/j2-csm-linear-parity.mjs`与窄比较/Node测试、本规格。root负责Cargo/GPU/J5登记；不改生产CSM/同步器/ABI/规划器、C4及J3已验默认路径。新文件小于300行，视觉仅深色1920×1080，数值目标尺寸按fixture保持。

## 实现与验证入口

`node scripts/j2-csm-linear-parity.mjs`默认删除旧native/web/evidence，再运行本次具名Native test，要求成功、非零passed及新JSON，然后执行Chrome三族两轮。`--web-only`仅Web本次，`--compare`仅历史比较。相同raw fixture SHA-256、实际production libraryHash及完整采样shader sourceHash随证据保存；Native与Chrome执行Native族的libraryHash必须相等。

每族每轮8种组合×49个点；两轮Chrome2352样本、Native784样本。GPU输入depth writer只是生成既有函数的4²depth-array边缘夹具；sampler仍按被测nearest/linear实际创建，完整production CSM函数调用不替换。Native复用现成lod_draw_readback staging/mapping，新CPU oracle独立实现相同fixture采样语义，原八项级联合同保持。

`node --test scripts/lib/j2CsmLinearParity.test.mjs`四项通过，包含手算linear=7/12、nearest=2/3，以及nearest冒充linear、旧fixture、缺情景、库源漂移和重复不稳定负例。lab类型检查、JS语法、oracle正式TS依赖打包、rustfmt及改动空白检查通过。

## 真机结果

主线默认fresh paired门通过，`currentRun=true`。Native10项CPU及1项真实GPU通过；Chrome三族2352个实际GPU样本、Native784个实际GPU样本，两轮稳定且有限。CPU参考最大误差和跨宿主最大误差均为`5.960464477539063e-8`；真实linear与nearest最大差值`0.1666666865348816`，错filter负例能够明确区分。原恒定七点同时覆盖，guard及共享混合核保持。

fixture SHA-256：`4c0bd74172d512824f701e4190e16c1a1be429705256a2f0a103bfaac6be0f5d`。Chrome与Native实际调用Native族的libraryHash同为`ee4ae5c6412b038eb6f42966317f6d73be61df79aa53d8356d651c75f7b005b7`，两宿主测试entry包装各有独立sourceHash。

| 实际执行族 | 完整采样shader sourceHash |
|---|---|
| Chrome TS built-in | `b27a345aed1ac2258defba79bc34c04c854173bc480e7cce9ff0aa9f1a85e36c` |
| Chrome DeepSL package | `97bf1b480769f3897ba633f644f2780f9f9a29f1f6b25ed0f44c03668a02a0dc` |
| Chrome Native production WGSL | `ec50308783a19ba418a560e611f9bcb569851a3336e3e492ecd370c00092dca2` |
| Native wgpu production WGSL | `dedcebcc5095def6fbc9302ef70b15a8af345fd2581437fba291c32af17d32f2` |

证据：`test-output/interrupted-0930/csm-linear/evidence.json`，本次Native日志`native.log`及主线`csm-linear-run.log`。两张`frame-{0,1}.png`均为深色1920×1080，已逐张检查：24组数值条带及标签完整，linear edge差异可见，无裁切。本刀为函数数值门，非完整产品场景画质验收。

该Native共同七点/linear PCF切片完成；单RTX4060/Vulkan与Chrome宿主不等于多物理设备完成。生产采样/性能路径未修改，未测GPU帧时收益；完整CSM规划/相机/场景画质仍不由本刀认证。
