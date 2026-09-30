# J2-B6 Bloom / Fog 现状与共同软膝首刀

本刀只将 TS 与 Native 的 max-RGB Bloom 软膝贡献数学接入同一 WGSL 真源，保留各自采样、参数、资源与模式合同。

## 现状核查

| 六步 | 已有（不重建） | 真实缺口 |
|---|---|---|
| 全仓源码与未跟踪 | 已查 packages/apps 中 bloom/fog/softKnee 消费及 git status；TS BloomPass、AuthorBloomPass、Native BloomPass 与四输出变体均在生产链。CSM/E-GPU并行文件不触碰。 | max-RGB软膝公式分别维护；三族算法不能仅按名称合并。 |
| 契约 | 已读 BloomOptions、AuthorBloomOptions、Native BloomSettings/FogSettings、ScenePostProcessingState、天气exp2合同与作者uniform。 | 合法数值范围、颜色亮度定义与soft knee边界不同，缺明确差异矩阵。 |
| 依赖 | pnpm既有Vitest/WGSL同步器与Cargo现有wgpu30/bytemuck足够。 | 新公共核需要登记/sidecar/生成镜像；不新增运行依赖。 |
| 消费方 | TS BloomPass创建compute module消费BLOOM_WGSL；PbrPostProcessChain选择旧Bloom或作者Bloom。Native renderer初始化创建BloomPass，blurred view和强度进入OutputPass。 | Native原shader只include raw文件；抽核后必须装配公共源，专项GPU仍应引用真实宿主factory。 |
| 测试与证据 | bloom.test/bloomEnergy/authorBloom CPU与生产链测试、lab bloomEnergy/authorBloom GPU、Native bloom_contract/bloom_gpu/fog_gpu已存在；第三波真实Bloom1/Fog1已过。 | 软膝零/阈值边缘/不同epsilon策略没有共享核身份与前后数值门。 |
| 规格 | 已读剩余表J2-B6、0930中断交接、J2-B2 Native公共输出规格；不重做公共ACES/作者分级。 | 共同Bloom数学可以机械提取；完整Bloom/Fog视觉与参数模式对拍仍后继。 |

## 模式与参数差异

| 家族 | 生产语义 | 必须保留 |
|---|---|---|
| TS旧Bloom | max-RGB；阈值0–65504、softKnee0–1、intensity0–16；4–12级金字塔 | knee=threshold×softKnee；knee=0时soft=0；软项分母4×knee；先2×2平均再RGB非负化；整数5tap与多级0.5重建；scene alpha保持 |
| Native Bloom | max-RGB；阈值0–64、softKnee0–1、intensity0–4、radius0.5–2；半分辨率prefilter/横纵blur | knee下限1e-5；软项分母4×knee+1e-5；每个线性采样先非负化再平均；分数偏移5tap与radius；OutputPass做强度合成与原alpha保持 |
| Three作者Bloom/TS AuthorBloom | Rec.709亮度阈值、0.01 smoothstep、固定5mip与6/10/14/18/22半径；strength0–3、threshold0–1 | 亮度定义、采样坐标、核权重、3×strength加权和与作者alpha逻辑；不接max-RGB软膝核 |
| TS作者雾 | linear、exp2、固定8步颜色混合；HDR作者颜色与depth语义 | 材质fog标记、参数与mix位置 |
| TS体积雾 | 半分辨率散射纹理；视图相机高度0、albedo、lightRadiance、HG含1/(4π)、32–64步及透射提前终止 | 散射与透射分别输出，现有资源与复合算法 |
| Native雾 | exp2在mesh内；exp/体积输出在HDR后；体积按世界eye高度、1–64步、HG相对项clamp0–4与雾色混合 | frame ABI、sample count、模式/RT消费、曝光上游与作者分级顺序 |

Native knee下限及epsilon会令零softKnee在阈值附近仍有微小贡献；TS硬阈值为零。共享核显式保留该差异，不扩大容差或改变用户参数来制造相等。

## 最小实施范围

设计读取沿用 `design-taste-digitaltwin`：本刀保持HDR亮部提取和用户已有视觉参数，未改布局/令牌，不声称完整场景画质或性能提升。

公共核拆为两条纯函数：软项计算显式接受brightness/threshold/knee/denominatorBias，贡献归一化接受brightness/threshold/soft。TS原knee>0分支保持；Native原knee下限保持，不增加模式分支。采样、brightness求值顺序、颜色非负化、blur、uniform、曝光、RT和输出源不变。源码只在管线创建时装配。

独占：本规格、`wgsl/bloomPrefilter.wgsl`与生成postprocess镜像/checksum门、`postprocess/bloomWgsl.ts`、Native `native_bloom_v1.wgsl`/`bloom_pass.rs`/`bloom_contract.rs`。共享同步器登记由root追加；Native OutputPass公共math、四输出body、C8、CSM与E-GPU保持其他线路所有权。

## 验证计划与状态

先保留旧TS与Native公式为独立参考，检查0阈值/0软膝/阈值两侧/非中性HDR参数。校验生成镜像与真源逐字节相等、两端实际shader装配恰有一份公共函数；复跑已有bloom/authorBloom/生产chain聚焦测试。GPU与Cargo仅由root串行执行，未测时保持待验证。

生产接线已定稿：TS `BLOOM_WGSL` 装配共享prefilter；Native `bloom_shader()` 装配相同真源与原采样/blur主体，生产 `BloomPass::new` 与合同测试使用同一factory。作者Bloom保持独立。公共源478字节，SHA-256 `21d7816d86e6f2ed5532a25222a72789f550f924d162b8c2dd40e624af7a963e`，sidecar/生成镜像由root同步；TS/Naga需要的资源绑定没有变化。

聚焦回归：`pnpm exec vitest run src/postprocess/bloomPrefilterWgslChecksum.test.ts src/postprocess/bloom.test.ts src/postprocess/bloomEnergy.test.ts src/postprocess/authorBloom.test.ts src/webgpu/pbrPostProcessAuthorBloom.test.ts lab/j2b2OutputFamilyAudit.test.ts`，6文件61 passed、2个既有Naga条件skipped。覆盖公共源身份/两端显式policy、旧Bloom预算/复用/能量、作者Bloom以及实际链选择；不把未启动的Naga或GPU写成通过。Rust格式与diff检查通过。

主线已跑Native `bloom_contract`：6 passed；Native Bloom实机1 passed，spread_pixels=124、bright_energy=55.965663、dark_energy=0、GPU errors=0，与提取前同机同probe一致。完整B6保持后继。

新增 `lab/j2BloomPrefilterGpuProbe.ts` 与 `scripts/j2-bloom-prefilter-gpu.mjs` 复用现有Chrome/esbuild/Playwright设施：固定旧生产提交 `cbce805a`，提取旧/current真实TS extract与Native fragment_prefilter数学段；每种profile16个向量，2轮共64组前后比较，覆盖0阈值/0knee/阈值两侧/knee两端/极小knee/RGB max/负通道/HDR65504。brightness、knee floor与denominator bias按原profile保留；输入为已采样颜色，仅验证有限数学。

GPU前后绝对误差门在运行前固定1e-6；独立逐步f32 CPU参考的相对误差门固定1e-6（分母max(1,abs(reference))）。报告每个生产源、冻结旧源、实际probe WGSL与canonical SHA-256；旧证据先清除、两轮稳定性单独检查。Native宿主、纹理采样、blur/pyramid、整帧与GPU帧时不在该数学门范围内。命令 `node scripts/j2-bloom-prefilter-gpu.mjs` 由主线执行；lab tsc及runner Node语法检查通过，边界/CPU参考与checksum聚焦6测通过。

主线已执行该命令：64组实际Chrome GPU前后比较全部通过，两轮稳定且每通道精确相等，maxBeforeAfterError=0、maxCpuRelativeError=3.725290298461914e-9，两轮GPU errors均为空。证据 `test-output/interrupted-0930/bloom-prefilter/evidence.json`，日志 `bloom-shared-browser.log`。实际提取与两套原策略保留已验，不扩为整帧Bloom/Fog完成。严格J5最新9对18腿通过，`degraded=false`，证据 `evidence-20260930052206.json`；本波runtime freshness通过。

完整后继：不同采样/blur/pyramid profile的共同非均匀HDR帧；Fog模式与参数合法差异矩阵；世界/视图高度与HG归一化边界；真实场景画质/帧时。完整J2-B6未完成。
