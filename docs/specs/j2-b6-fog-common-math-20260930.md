# J2-B6 雾的高度密度与透射共同数学

本刀复用 TS 与 Native 正在消费的两条相同公式，保留各自雾模式、坐标、采样及合成合同。

## 现状核查

| 六步 | 已有（不重建） | 真实缺口 |
|---|---|---|
| 源码与未跟踪 | 已查 packages/apps fog/exp/density 调用及工作区状态；TS作者雾、半分辨率体积march与Native两套output fog均有真实生产消费。 | 高度密度和Beer透射在宿主间重复维护。 |
| 契约 | 已读VolumetricMedium、VolumetricFogPassOptions、FogSettings及作者雾uniform；TS步数32–64，Native1–64，Native作者fog颜色/密度有独立范围。 | 只能机械提取相同数学；不能把相同名称当相同模式。 |
| 依赖 | package/Cargo已有WGSL同步器、Vitest、esbuild、Chrome runner与wgpu30。 | 无需新平台、库或ABI。 |
| 消费方 | VolumetricFogPass创建实际compute；PBR_FOG_WGSL进入sceneShader；Native OutputPass装配fog/bloom-fog两个body。raw include已全查，除factory仅合同及profile专项target消费。 | 新公共核必须实际装配；更新既有字面合同而保留物理和顺序断言。 |
| 测试证据 | volumetricFogPassCpu与CPU reference、PBR雾集成、Native fog_gpu和bloom_contract已存在；既有实机雾首刀通过。 | 缺共享源身份和相同生产表达式提取前后的有限向量GPU门。 |
| 规格 | 已读B6现状、B5生产GI接缝、Nativeprofile和全剩余清单。 | B5 storage有不同绑定/网格metadata，另刀处理；本刀不重复Bloom软膝或Native输出profile。 |

## 保留合同

共同式仅 `baseExtinction * exp(-max(height, 0.0) / scaleHeight)` 与 `exp(-opticalDepth)`。

TS体积雾仍按视图原点高度、32–64步、HG含1/(4π)、散射RGB/透射A及提前终止消费；Native按世界eye高度、1–64步、HG相对项及0–4夹取，输出HDR雾色混合。TS作者linear/exp2/八步模式和材质fog标记保持；Native mesh/RT的exp2函数保持。颜色、曝光、Frame/作者uniform、RT、资源和profile均不改。

## 实施与验证

已将 `wgsl/fogOpticalDepth.wgsl` 接入TS生成镜像与Native include；公共函数为 `deepFogDensityAtHeight`、`deepFogTransmittance`，236字节，SHA-256 `dfb5aa39450308be7a885486796f1f4dcb910f6e498df9e4a9f34200a3de6a46`。同步注册、sidecar与镜像由主线生成。实际PBR作者/径向雾、TS体积march与Native fog/bloom-fog两body消费共同核；管线创建时装配，调用外的metric平方、clamp与步进顺序保持。全部生产源已冻结。

Native OutputPass仅在fog开启时拼接公共核；plain与bloom-only字节不增加Fog源。既有profile选择门同步检查新装配body，只允许ACES shim选择变化。Fog共同数学是profile首刀之后的有意字节变更，原profile提交 `75421e61` 的默认字节保持证据仍属该切片，不据此声称新Fog装配字节不变。bloom_contract保留深度投影、世界高度、HG、步数与ACES前后顺序，三条字面公式改查实际真源与生产调用。

旧公式取本刀前固定commit `75421e61`；独立GPU probe沿用Bloom runner设施，记录当前实际消费源hash、canonical hash与before/after shader hash。四生产族各128个高度/密度/尺度/步距/模式向量，两轮共1024组。误差门在测量前固定GPU absolute 1e-6与CPU relative 1e-6，另报告前后精确相等；要求有限输出和两轮稳定。CPU参考独立。只验证有限数学，不将其写成双端整帧/相位/坐标/性能已验。Native现有fog_gpu与profile四变体由主线串行真机执行。

TS聚焦六文件61 passed、1个既有Naga条件skipped；包括canonical身份、生产接线、CPU积分、pass资源消费与PBR作者模式/材质fog标记。Engine/lab类型检查、四族前后生产公式提取的纯Node检查、runner语法与Rust格式/diff通过。新增代码均低于300行，未新增依赖、UI选择器或体量豁免。

主线实际Chrome GPU：两轮各512组，共1024组，`passed=true`、`stable=true`、所有before/after通道精确相等；最大前后误差0，最大CPU相对误差8.389274738164282e-7，两轮GPU errors均为空。两张1920×1080深色摘要截图已逐张检查，四族结果完整，无裁切；该页面是数值证据，不是产品场景画质验收。

Native合同六测通过；既有实际Fog输出一测通过，RTX4060/Vulkan：disabled `[0.98779297,0.38964844,0.23278809]`，enabled `[0.9824219,0.38964844,0.87597656]`，GPU errors=0。证据分别为 `test-output/interrupted-0930/fog-common-native-contract.log`、`fog-common-native-gpu.log`；Chrome完整数值见 `fog-common/evidence.json`，摘要见 `fog-common-browser.log`。

提取后Native profile装配门3 passed、1显式GPU ignored；独立执行该GPU测，两轮四变体共224组通过，最大误差0.00048828125、GPU errors=0。证据 `fog-common-native-profile-target.log` 与 `fog-common-native-profile-gpu.log`，未把ignored计为实测。

```powershell
pnpm exec vitest run src/fog/fogOpticalDepthWgslChecksum.test.ts src/fog/volumetricFogPassCpu.test.ts src/fog/volumetricFogPass.test.ts src/webgpu/pbrFogIntegration.test.ts src/webgpu/pbrFog.test.ts src/webgpu/pbrVolumetricFogIntegration.test.ts
node scripts/j2-fog-common-gpu.mjs
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test bloom_contract
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test native_output_profile
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test fog_gpu -- --ignored --nocapture
```

首条命令在deep-engine包执行，其余在仓根执行。数值结果写入 `test-output/interrupted-0930/fog-common/evidence.json`；夹具摘要沿用base.css深色令牌，截图1920×1080，数值输入合同保持。

完整后继仍包括非均匀HDR Bloom采样/blur/pyramid、Fog的合法差异矩阵、共同场景帧、完整高度/HG profile选择与帧时。
