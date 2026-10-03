# I-C23 后继：活动层清漆直射消费核查

下一刀选择活动层 clearcoat 的主方向光直射消费，复用 Browser 现有 T08 求值核。Native 基材扩展、各向异性、透射仍保留发布拒绝；本刀不关闭完整 I-C23。

## 现状核查

1. 全仓 packages/contracts/src、packages/deep-engine/src、packages/deep-engine-native/src / assets/shaders、apps/web/src 检索 layered / clearcoat / anisotropy / transmission / deepEvaluateExtendedMaterial，并检查未跟踪项。分层 shader、304B 打包、两端发布守卫与本日 RT / 白炉叶均已存在。Native 没有扩展瓣求值函数，不重写层混合或纹理底座。
2. 已读契约材质类型、materialParameters / materialLayeredParameters / materialLayeredSurface / materialParameterAbi、Native contract/types / validate_layered_params 和 capability manifest。factor/roughness/strength/transmission 为 0..1；IOR 有限 f32 且≥1；rotation 有限、TS 规范化到(-π,π]；coverage 缺省0。304B 活动行 params0=[IOR,coatFactor,coatRoughness,anisoStrength]、params1=[anisoRotation,transmissionFactor,0,0]。Native capability material-clearcoat 当前 unavailable，不能因为行数据已携带而改成完整支持。
3. package.json 已有 Vitest / esbuild / TypeScript，Cargo 已固定 wgpu / serde；数学共享化沿既有 wgsl:sync / checksum / Native include_str! 链，无新依赖。
4. 已追实际消费：Web pbrShader.extendedShade → composeLayeredMaterialSceneShader.deepLayerBaseShade → deepEvaluateExtendedMaterial；Native native_lit_response → deep_layer_stack → native_lit_response，RT 包装同样调用该层核。层 baseColorRGB、alpha、MR.G/B、UV0/1、变换和颜色编码已进真 shader；Native 仅读取 params0.x，未读取 coat 参数。两端响应混合都复用 materialLayerBlend 唯一核。
5. 已读 materialEvaluate / materialEvaluateWgsl / clearcoatSemantics 现有测、packageClearcoat CPU 参考、Web clearcoat炉 evidence、I-C23 双端白炉/RT 真机门、SDK finaldist before/after 与 Native guard 证据。stock 层响应、打包/发布已验，不重建。活动层 coat 没有 Native 真响应证据。
6. 已读 remaining 表、active-task-recovery-ledger、GLM handoff、I-C23 production/native-consumption/furnace/RT/guard 规格。完整 I-C23仍剩扩展响应与验收；本日 I-C19 已收口。J5 最终源冻结中，全部后继草稿放 ignored `test-output/i-c23-material-consumption-next-20261001/`；不修改生产、既有 lab、Cargo 或 GPU。

**已有（不重建）**：双端层色/MR/alpha/UV、sRGB/linear 编码、304B 行、纹理资源owner、凸混合、RT层族、零覆盖剪枝、T08三瓣纯函数核和C9闭式参考、双端发布fail-closed。

**真实缺口**：Native 活动层 coatFactor/coatRoughness 未进入实际求值；目前通过守卫明确拒绝。只补此瓣的方向光分支可沿现有 ABI 接通，无需160B基材扩展。

## 字段→实际消费

| 字段 | Browser | Native | 后继 |
|---|---|---|---|
| baseColor + RGB texture | layer surface → deepLayerBaseShade；颜色纹理按sRGB | layer_base×color.rgb；prepare encoding→GPU format | 已有 |
| color texture alpha | coverage×alpha | coverage×color.a | 已有 |
| metallic / roughness + MR.B/G | layer表面→shade与扩展core | layer_metal / layer_rough→native_lit_response | 已有 |
| texCoord0/1、offset/scale/rotation | slotUv，独立base/MR行 | transformed_uv，独立base/MR行 | 已有 |
| coverage / mode | deepLayerBlend | 同一WGSL deepLayerBlend | 已有 |
| layer IOR | deepDielectricF0(params.x) | deepDielectricF0(row.params0.x) | 已有 |
| layer clearcoat.factor / roughness | deepEvaluateExtendedMaterial主方向光 | 尚未消费，发布拒绝 | 本刀 |
| layer anisotropy / transmission | 同core主方向光 | 尚未消费，发布拒绝 | 后继 |
| layered.base 扩展瓣 | 活动栈base传入扩展带求值 | 基材普通路径，发布拒绝 | 后继，需正式基材参数载荷 |

## 最小语义

Browser 的此生产路径与 ShaderPackage C9 的完整clearcoat IBL适配是两条已有路径：这里清漆仅替换主方向光的直接响应，local / IBL / GI / emissive保持stock。Native应匹配这条现有生产语义，不把C9独立ShaderPackage适配当作当前层栈已消费。

factor=0 时直接返回既有 native_lit_response，逐位保留普通响应，包括roughness非零。factor>0时按 Browser 次序：stock完整响应 − stock主光BRDF/多散射直接项 + 既有T08扩展clearcoat直接项×阴影visibility。Native所用sun必须沿原native_lit_response的作者光选择，不把frame.sunColor.w的语义搬成Web强度。

coat只对活动层放行，活动base三瓣与layer aniso/transmission继续拒。已有shader只在分层包装取row；新普通数学core不可读取层uniform/纹理。Native层包装接收参数值并调用数学core，普通入口继续只达stock core，避免naga静态可达层binding回归。

T08扩展直接核与stock correlated-Smith/C8多散射核不同；从factor=0切到factor>0会切换主直接求值家族。该行为来自既有Browser生产实现，后继应明确记录而非宣称无限小factor连续或完整Clearcoat IBL。公共主光数学收敛归J/C，不在本刀改stock核。

## 文件锁建议

1. 将既有 `shader/materialEvaluateWgsl.ts` 的无绑定核心迁至 `wgsl/materialEvaluateCore.wgsl`，经 `scripts/syncSharedWgsl.mjs` 生成新镜像与checksum；原公开常量仍组合既有dielectric与同一core。参数struct保持materialParameterAbi逐字锁，Web结果不变。新core可携现有三瓣函数，但只放行/调用清漆参数，其余支持范围不扩。
2. Native `native_mesh_wgsl.rs` include同一纯core；新增 `assets/shaders/native_layer_extended_v1.wgsl` 层清漆包装；`native_mesh_v1.wgsl` 的deep_layer_stack将行响应调用改为该包装。RT通过现有共享层核自动消费，不新增光照副本、不改layout/PSO族。
3. SDK `runtimePackage/renderPacketNativeMaterial.ts` 与测试只放行layer coat；Native `contract/validate_layered_params.rs` 与测试同边界。base与layer aniso/transmission保持拒绝。普通Capability material-clearcoat仍不能标Full。
4. 新独立 `lab/iC23LayerClearcoatProduction.ts` 与 runner模式；新独立 Native `renderer/layered_clearcoat_gpu_tests.rs`，仅在既有bin测试模块挂载。既有layered whitefurnace与RT门不复制。

新增叶≤300行；既有native_mesh_v1.wgsl已近大小门，包装必须单独文件。生产/lab锁需root解除J5冻结后才实施。

## 独立CPU oracle与GPU入口设计

CPU草稿调用真实dist evaluateExtendedMaterialDirect / evaluateClearcoatReference；独立f64闭式重算GGX/Schlick/clearcoat，用法线视线主光角、base/MR/IOR/factor/roughness矩阵验证实际旧核，另用半球积分给指定材质的能量参考。提取现有无绑定WGSL字节并核对唯一dielectric/参数struct，不从新carrier推断消费。

Web真实门沿已有PbrRenderer/FrameCaptureSession/opaque-hdr/present，dark1920×1080两fresh：活动coat层、factor0、coverage0、保存重开、非法aniso/transmission保持旧包；主光/阴影与环境分离，局部光/IBL/emissive保持有独立帧。层混合参考取真实父帧，直接coat部分再对CPU闭式。

Native新bin GPU门请求19纹理与现有RT能力：普通base、coat层raster、coat层RT各实际上传+PSO+HDR回读；ray-query实际进入与六变体validation沿现有readiness合同。无阴影主光先隔离数学，RT/raster逐像素比较；factor0与旧stack逐位身份、coverage0普通材质身份。root独占GPU队列，在J/C之后运行两独立fresh并保留源哈希与真实命中；没有实际执行前均保持待验。

设计读取沿Unity PBR层响应与西门子材质数值语义；已加载design-taste-digitaltwin。此次仅核查/CPU草稿，产品截图与Kimi-95评分待实际生产视觉，不提前关闭整项。

## 本轮只读/CPU结果

`probe-clearcoat.mjs` 调用最终dist既有CPU函数，960组角度×factor×coat roughness×base MR闭式对拍 PASS，最大按 `(1+|期望|)` 归一误差 `1.4468674419229273e-14`，清漆标量最大绝对误差 `1.734723475976807e-18`；分量和恒等验证通过。同核清漆开/关最大直接响应差 `3.970915830142559`，可用于设置实际HDR可辨门，不能当作Native已消费。

指定 baseColor=.9 / roughness=.6 / metallic=0 / normal-view 的6组 cosine quadrature（每组32768点）：factor0 能量 `.8942629765347823`；factor.7/rough.35 `.8960007028065132`、rough1 `.8777896691857574`；factor1/rough.35 `.8967454426796386`、rough1 `.870729679921141`。均≤1，仅支持这些指定输入。既有 clearcoatSemantics 已明确 Schlick分离G在斜视的lobe包络κ=1.66，后继不能据这6组法向参考外推全参数白炉≤1，不能放宽现有炉容差吸收差异。

既有3文件24测 PASS（materialEvaluate / materialEvaluateWgsl / clearcoatSemantics）。从既有WGSL常量去除唯一dielectric段，所得core草稿5977B / 133行、SHA `93f565684f069ea5fab7ecc4448b45da955835f466d014e298e9ecef16100826`，保留完整既有参数struct，断言不含group/binding/入口/textureSample。`native_layer_extended_v1.wgsl` 包装草稿22行，只取传入参数值。两者均在ignored目录，尚未接线、naga校验或GPU执行。

证据在 `test-output/i-c23-material-consumption-next-20261001/{probe-clearcoat.mjs,cpu-oracle-receipt.json,cpu-oracle.txt,materialEvaluateCore.wgsl,native_layer_extended_v1.wgsl,existing-core-tests.txt}`。生产、既有lab与其索引无修改，无Cargo/GPU/commit。
