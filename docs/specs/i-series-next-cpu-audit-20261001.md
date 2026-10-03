# I 系列下一批 CPU 核查（2026-10-01）

I-C16、I-C19 之外，当前最高价值的 CPU 子项是 I-C23 Native 分层材质发布守卫：拒绝生产 shader 尚未求值的活动扩展瓣。此次只读核查，不修改生产源或关闭整项。

## 现状核查

1. 全源检索 packages/contracts/src、packages/deep-engine/src、packages/deep-engine-native/src 和 apps/web/src 的 layered / extendedParameters / clearcoat / anisotropy / transmission，并检查 git status --short 的未跟踪项。既有分层 CPU 叶、runtimePackage 闭字段解析、Native 分层核与本日 RT / 白炉新增文件均存在；没有另一份 Native 材质支持分类叶。I-C16 CLI 保持冻结，并行文件不改。
2. 已读 contracts rendererCapabilityManifest、TS renderPacketTypes / materialLayeredParameters / materialLayeredSurface、Native contract/types / validate。base+≤2 层、IOR/清漆/各向异性/透射和 304B 行合同已齐。Native 契约承认扩展字段，但 validate_layered_material 只校验层数、coverage、surface；不校验 LayerMaterialParams 数值域或支持范围。
3. deep-engine package.json 已有 Vitest / TypeScript，Native Cargo.toml 已有固定 serde / wgpu。分类守卫不需新依赖、ABI 或材质框架。
4. 已追消费链：公开 buildDeepRuntimePackage → 内部 validateRuntimeRenderPacket → layeredMaterialExtension → prepareRenderPacket；公开 validateDeepRuntimePackage 会重验 render-packet。Native pbr_layered::layer_params 打包全部六参数，但 native_mesh_v1.wgsl 除行声明外只读取 row.params0.x（IOR），不读取其余五参数。Web composeLayeredMaterialSceneShader 则将整行交给 deepLayerBaseShade。TS 已要求 layered.base.ior 与 material.ior 一致，Native scene_pack 使用 material.ior；该一致性守卫不重建。
5. 已查 runtimePackage/renderPacketBrowserMaterial.test.ts、materialLayered*.test.ts、Native pbr_layered_contract_tests、reports/test-output。既有测试明确放行 Native 层 strength=.2，而 Native shader 未消费此字段。现有 CPU 3 文件 34 测全过，不能证明支持域正确。本次使用最终 dist 的公开 SDK 构包和验证，实际复现见下表。
6. 已读 remaining-tasks-estimates-20260930.md、active-task-recovery-ledger.md、GLM handoff、I-C23 production/native-consumption/furnace-attribution/RT-pipeline 规格和本日续跑规格。权威 I 表尚未关闭的只有 I-C16、I-C19、I-C23；C8/I-C8 与 J/C 当前主线共用，不另开重复项。I-C14/27/31 为观察或条件触发，I-C22 已并 T13，均不提升为当前开发任务。I-C23 本日双端白炉与 RT 分层已真机通过，不重复建设。

**已有（不重建）**：双端层色/MR/纹理/UV、304B ABI、凸混合、TS 参数规范化、Browser 保存恢复、Native RT 层族、白炉和 RT/raster 真机证据、基材 IOR 一致性。

**真实缺口**：Native 发布成功承诺了未求值的活动清漆、各向异性和透射，以及活动层栈基材上的扩展瓣；直接 Native JSON 入口还缺扩展参数数值域与同一支持边界验证。可先补 SDK 发布守卫，不改变材质求值。

## 最终 dist 公开 API 复现

入口为 `@bim-studio/deep-engine/runtime-package` 的 `buildDeepRuntimePackage` 和 `validateDeepRuntimePackage`。仓内与 dist 均没有 `validateNativeRenderPacketProfile` 符号。

使用已有 Native `fixtures/render_packet_v1.json` 的非空场景，转正式 typed geometry，逐案加 layered 并真实构包，再用公开验证器复验。

| 场景 | 当前结果 | Native 消费依据 |
|---|---|---|
| 普通 stock | 构包成功 / valid=true | 已有支持 |
| 活动层 IOR=1.2 | 构包成功 / valid=true | row.params0.x 实际消费 |
| 活动层 clearcoat.factor=.7 | 构包成功 / valid=true | 该因子未消费 |
| 活动层 anisotropy.strength=.8 | 构包成功 / valid=true | 该强度未消费 |
| 活动层 transmission.factor=.6 | 构包成功 / valid=true | 该因子未消费 |
| layered.base.clearcoat.factor=.7，存在 coverage=.5 层 | 构包成功 / valid=true | Native 基材无扩展瓣求值 |
| layered.base.ior=1，与 stock IOR=1.5 不同 | 已拒绝 | 既有 prepareMaterialTextures 一致性门 |
| coverage=0 的层含 clearcoat.factor=.7 | 构包成功 / valid=true | 层被剪枝，无新增着色承诺 |

证据：`test-output/i-series-next-cpu-audit-20261001/finaldist-native-profile-repro.json`。既有 34 测日志 `existing-cpu-tests.txt`。本次未运行 Native 二进制，因此 Native 直接入口的未拒绝结论来自 validate.rs 代码，后继应由真实 Rust 合同测试确认；不以 TS 构包代替 Rust 运行证明。

## 最小实施与文件锁建议

SDK 首刀建议新叶 `packages/deep-engine/src/runtimePackage/renderPacketNativeMaterial.ts`（目标 ≤100 行），只定义内部 Native 分层支持判定；`renderPacket.ts` 的 Native profile 分支调用。新增同名聚焦测试，调整 `renderPacketBrowserMaterial.test.ts` 的 Native 正向 fixture，保持 Browser 非零扩展 roundtrip 原测。

判定复用已规范化层合同：有活动层时检查 base；逐活动层拒绝 clearcoat.factor / anisotropy.strength / transmission.factor 非零，报精确材质路径与未支持字段。零因子下 roughness / rotation 保持可携带；coverage=0 层保持既有剪枝语义。IOR、层表面/纹理/覆盖率、模式沿既有验证器。不能让该守卫影响 Browser profile。

最小回归：三种活动层扩展分别拒绝、两层中第二层拒绝、活动基材三瓣拒绝、零 coverage 与零因子参数允许、合法层 IOR 与纹理允许、Browser 三瓣保留；公开 buildDeepRuntimePackage 拒绝非法发布，公开 validateDeepRuntimePackage 对重新签名的同类包也拒绝，输入快照不变。

Native 直接 JSON 入口另需 `contract/validate.rs` / 独立参数验证叶和合同测试，做同一有限数值域及活动支持门。该刀涉及 Native 构建归 root 串行，不纳入本路冻结后的自行修改；只修 SDK 会留直接 Native 输入缺口，文档必须保留。

## 验证入口与范围

- 既有 CPU：包内 `pnpm exec vitest run src/runtimePackage/renderPacketBrowserMaterial.test.ts src/shader/materialLayered.test.ts src/shader/materialLayeredSurface.test.ts`，本次 34/34 PASS。
- 后继聚焦：新 Native material guard、runtimePackage 构包/验证/roundtrip、Browser 扩展保存恢复；然后 engine tsc / purity / size，root 重建 dist 与 freshness。
- Native 后继：既有 pbr_layered 合同测试加直接 serde→validate 的拒绝/允许案例，由 root 控制 Cargo。

这是 I-C23 支持边界修复，不增加扩展瓣求值；完整扩展消费、雾序差与产品验收仍按权威计划推进。无 UI/GPU 需求，可在 J5 源冻结解除后做这一刀。

## SDK 守卫实现与复验

root 在 J5 strict 32 腿通过后解除本刀冻结。独立草稿先置于 ignored `test-output/i-c23-sdk-profile-guard-20261001/`，随后提升到正式源码并接线。

- 新 `runtimePackage/renderPacketNativeMaterial.ts` 26 行：仅扫描已有规范化层合同，活动栈检查 base，活动层逐原始索引检查三个扩展强度。schema / 数值域仍由原 layeredMaterialExtension 负责，避免复制规范化或再次分配参数对象。
- `runtimePackage/renderPacket.ts` 仅追加 import 和 Native profile 调用。Browser 分支保留原支持域；base IOR 一致性仍走既有 prepareMaterialTextures。
- 新 40 测覆盖三种层/基材拒绝、精确错误路径、前行剪枝后的索引、零覆盖、缺省覆盖率=0、零因子 roughness / rotation / IOR / 表面纹理允许、非法数值仍拒、输入不变、公开构包拒绝和正确重新签名的非法包拒绝、Browser roundtrip。
- 既有 Browser 材质测试只将 Native 正向 fixture 的 strength 改 0；原 Native 非法字段测试也先归零，保证失败来自各自被测规则。

实际验证：4 文件 74 聚焦测 PASS；42 文件 477 runtimePackage 测 PASS；src / lab / examples 三次 tsc PASS；purity 979 browser/core、705 native PASS；git diff --check PASS。新测试 117 行，两新叶均低于 300 行。

日志：`test-output/i-c23-sdk-profile-guard-20261001/{focused-tests,runtime-package-tests,typecheck,purity}.txt`。生产源已冻结并通知 root 重建 / freshness；上节 finaldist 记录为修复前证据，修复后 dist 公开消费须待该重建。Native 直接 JSON 数值与支持门由 jc_epa 接手，当前 SDK 子集不代替 Native 验证。

root 最终 SDK build 成功后，已用 dist 的同两个公开 API 实跑 11 个发布案例与 6 个正确重新签名的非法包：活动层/基材三扩展全部报精确字段拒绝，合法层 IOR、零因子非零 roughness / rotation、零覆盖行和无活动栈保留；全部输入保持不变。六个重签名包由公开 validateDeepRuntimePackage 拒绝，包含层三瓣与基材三瓣。

修复后证据独立保存在 `test-output/i-c23-sdk-profile-guard-20261001/finaldist-native-profile-after.json`，修复前证据保留原路径。该记录含最终 builder / parser / guard 的 SHA-256；guard 为 `c1988dcc39faf3523f1828845699249a15149c3a7b6e20ea2d45f9e926f1eb84`。仅更新证据与本规格，生产冻结保持。
