# I-C23 活动层清漆生产切片

将已有T08直接光求值核共享给Native活动层；只放行层清漆，基材清漆、各向异性和透射继续明确拒绝。草稿与CPU证据位于 ignored `test-output/i-c23-layer-clearcoat-20261001/`；root审查批准后23文件已提升，正式源现已冻结，等待串行GPU验收。

## 现状核查

1. 复查全源clearcoat/layered及未跟踪项：Web层shade、Native层stack/RT包装、两端params guard已存在；没有Native清漆消费，不复制纹理/PSO/层混合。
2. 已读TS材质参数/层surface/304B ABI、Nativetyped合同及参数guard。row.params0.y/z即coat factor/roughness；coverage默认0；factor0可携roughness。普通基材160B没有coat载荷，不扩ABI。
3. package已有Vitest/esbuild/TS，Cargo固定wgpu/serde；新增共享WGSL沿现有sync/checksum，不增依赖。CPU稿使用已建dist和既有serde rlib，不运行Cargo/GPU。
4. 消费链逐字段复查：Browser层包装调用deepEvaluateExtendedMaterial并替换主直接光；Native普通native_lit_response由raster/RT共用，只有deep_layer_stack读层binding。新增数学core无资源，新增layer wrapper接参数值，普通入口不可静态触达层资源。
5. 现有materialEvaluate/clearcoatSemantics 24测及上一核查960闭式/6指定积分已过；SDK/Native发布guard已真实调用复验。分层白炉与RT旧门已两fresh，不代替活动清漆新证据。
6. 已读权威remaining、恢复ledger、handoff、I23消费/白炉/RT/guard与i-c23-material-consumption-next规格。J/C GPU队列优先，J5完成并root审查解锁前不提升；C9 κ1.66不外推全域炉≤1。

**已有（不重建）**：T08 CPU/WGSL数学、C9clearcoat闭式、两端304B/纹理/混合、RT层管线族、资源owner、闭字段参数规范化/拒绝、GPU真实renderer与HDR回读。

**核查时真实缺口**：Native row coat参数未进入直接求值；共享数学来源、层包装调用、支持域放行缺失。上述源码现已接入，真实GPU/HDR证据尚待主路验收。

## 语义与提升边界

factor0原样返回stock响应。factor非零沿Web既有主方向光替换，local/IBL/GI/emissive保持stock；清漆不增加IBL瓣。数学函数逐字迁移，Web导出的完整WGSL组合要求逐字相等。shared core删除唯一dielectric段；Web包装在唯一const锚前恢复该段，Native保持既有dielectric include再include该core，避免重定义。

Native layer wrapper仅读传入params0，只有layer stack取304B。普通raster/RT保留stock可达图。支持门仅对active layer coat放行；activebase三瓣与layer aniso/transmission继续拒绝，数值域/IOR一致性原门保留。

计划提升清单：shared core/.sha256/生成镜像/校验测试、materialEvaluateWgsl薄组合、sync登记；Native组装、新layer wrapper与stack一处调用；两端guard及现有测试；独立Native直接HDR oracle腿和既有RT fixture追加coat case（复用同一executor），Web独立生产门稿。全部新增叶≤300行。

## 验证安排

CPU：闭式原960组复验、共享字节/参数struct/唯一dielectric、Web完整shader逐字身份、Native普通入口可达图不引用层binding、coat层可达新core、guard公开构包/重签名验证和Browser保存恢复、实际Nativetyped→validate合同稿。

Native直接HDR门用既有全帧平墙/固定相机与真实render helper；主光与墙法线对齐、IBL/local/emissive/雾关闭，逐像素视线角闭式直接参考。factor0对旧stock逐位身份，coverage0对普通基材逐位身份；RT追加实际进入+HDR parity，独立raster闭式门证明清漆变化。设备19纹理不足或RT缺失须记录soft skip，不能算完成。

Web沿真实PbrRenderer/FrameCaptureSession/opaque-hdr/present，以实渲base/带清漆且带颜色与MR纹理的父帧构造单层replace参考，权重严格等于f32覆盖率×纹理alpha；独立数学参考由Native墙腿及CPU闭式提供。factor0/coverage0/保存恢复逐值恒等；dispose清零、validation与诊断清洁。root串行两fresh，GPU前不宣称生产切片完成。

Design Read沿Unity PBR层响应与工业数值语义；已有skill已加载。本次CPU/草稿不替代产品视觉两轮及完整I23验收。

## 已实现与CPU证据

共享 `materialEvaluateCore.wgsl` 为5977B/133行，SHA-256 `93f565684f069ea5fab7ecc4448b45da955835f466d014e298e9ecef16100826`。Web薄包装将唯一dielectric段恢复在原位置，完整sceneShader在提取前后105289B逐字相同（SHA-256 `5d6f86227d2c1e01d5902626dc105c32a0909c57fa1b258f2e9a111072f27a9c`）。Native保持原dielectric单定义并包含同一core，新增23行layer wrapper仅接标量params0，stack中一处调用实际消费y/z。160B基材及304B层ABI未变。

| 验证 | 结果 | 本地证据 |
|---|---|---|
| 正式SDK同族/guard/Browser/共享core | 6文件80项通过 | `formal-vitest.txt` |
| 正式共享core checksum | 3项通过 | `formal-wgsl-checksum.txt` |
| 三套tsc | src/lab/examples全部通过 | `formal-tsc-{src,lab,examples}.txt` |
| Native实际typed→validate | 9项通过，活动层coat放行，基材3瓣/层其余2瓣拒绝 | `formal-native-contract-tests.txt` |
| Native实际factory/checksum/naga | 15项通过；raster10/RT11普通入口无group1≥11绑定，层入口使用11..19 | `formal-shared-tests.txt` |
| 实dist CPU T08/C9与独立f64闭式 | 960组，max scaled error1.45e−14 | `cpu-oracle-receipt.json` |
| GPU墙腿的原Rust闭式函数与实dist T08 | 1369视线点，max error8.16e−15 | `wall-oracle-receipt.json` |
| source-size/purity | failures0；175既有体量warning；runtime purity通过 | `formal-source-size.txt` / `formal-purity.txt` |

证据文件均位于 `test-output/i-c23-layer-clearcoat-20261001/`。Native CPU使用缓存wgpu/serde rlib直连真实模块，未启动Cargo或GPU；GPU测试完整Rust编译仍由主路执行。新增叶最大140行，lab入口新增后仍≤300行。

`promotion-manifest.json`记录23个正式文件原SHA和最终SHA，提升前逐项检查全部一致才写入；`supportOnly`项仅为草稿include上下文，从未提升。`formal-source-freeze.json`冻结2742个引擎src/WGSL/lab/Native src/shader源文件及两脚本。后续变更必须刷新构建与GPU证据。

六组积分只覆盖baseColor0.9、base roughness0.6、metallic0、法线视角、factor0/0.7/1及coat roughness0.35/1，32768采样/组，积分0.8707..0.8967。它们不证明全域白炉≤1；既有C9 grazing κ1.66边界继续有效。非零factor使用T08 SchlickSmith并替换stock主灯，因此不承诺factor→0在两种核心之间的连续性。

## 主路真实验收入口

GPU前由主路统一构建SDK/WASM/Native，并逐腿两轮新device。以下命令从仓库根运行，GPU队列必须串行：

```powershell
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --bin deep-engine-native layered_clearcoat_main_light_matches_closed_response_and_zero_identity -- --ignored --nocapture --test-threads=1
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --bin deep-engine-native rt_layer_clearcoat_pipeline_matches_raster -- --ignored --nocapture --test-threads=1
$env:C23_GATE_MODE='clearcoat'
node scripts/i-c23-production-layered-material.mjs
```

Native墙腿逐65536像素对独立f64闭式，误差≤0.002；coat与stock差>0.02且改变>500像素；factor0与coverage0逐值恒等。第二组辅助帧主灯0、IBL开、GI倍率2且有自发光，活动coat与stock逐值恒等。局部灯仍通过stock-minus-main-plus-extended公式保留，未另建局部光核。

RT腿复用现有executor/typed packet/readiness/6种layered管线，clearcoat参数覆盖同一层；HDR对raster误差≤0.002。日志须含 `rt_layered_executed=true`、`clearcoat=true`，普通layer test仍保留。Native adapter/19纹理或RT不足日志明确 `scope=not_executed`，跳过不算验收。

Web脚本自身两fresh realm，保存1920×1080真截图与HDR回读，receipt `test-output/i-c23-layer-clearcoat-20261001/web-gpu/evidence.json`。混合参考误差<0.002，真实coat差>0.001，零因子/覆盖零/保存恢复误差0；实际可见像素>100000、colorBins>5；sourceFresh/stable/validation/dispose全过才pass。整项I-C23还包括未支持瓣、基材扩展及完整编辑体验，本切片不得作为整项关闭。

## 主路真实 GPU 结果

2026-10-01 主路独立启动两次 Native 墙腿，均实际执行65536像素；闭式最大误差0.00024710655，coat响应差0.15435791、38224像素改变。factor0、coverage0及主灯关闭后的IBL/GI/emission均逐像素恒等。日志 `test-output/jc-i-20261001-layer-clearcoat-native-round{1,2}.log`。

两次独立 RT 进程均在 RTX 4060 Laptop/Vulkan 实际进入ray-query；六种层管线真实执行，RT/raster最大HDR差0，coat差0.2770996、28919像素改变。两日志均有 `rt_layered_executed=true` 与 `clearcoat=true`，不是soft skip。日志 `test-output/jc-i-20261001-layer-clearcoat-rt-round{1,2}.log`。

Web两fresh realm均通过：最大组合误差0.00019033399，coat差0.019775390625，factor0/coverage0/保存恢复差0，dispose资源0，validation错误空；实际可见像素716800、色彩bin数9，sourceFresh/stable均true。入口日志 `test-output/jc-i-20261001-layer-clearcoat-web.log` 与上列Web receipt。主路已查看两轮深色1920×1080截图：覆盖、边界、纹理色区与画布一致。截图是材质数值诊断视图，未作为作者完整编辑体验或工业场景视觉评分。

活动层清漆主光切片实测通过；I-C23整项计数保持开放。新增数学后旧分层白炉/RT回归、WASM和全链J5收据按当前源码刷新。
