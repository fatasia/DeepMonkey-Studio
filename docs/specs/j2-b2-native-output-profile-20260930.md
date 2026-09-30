# J2-B2 Native 可选输出 profile

运行包可显式选择既有 `deep-aces` 或 `three-aces-r185` 数学，默认 Native 输出、作者六通道与曝光位置保持。

## 现状核查

1. 已检索 packages/apps 与未跟踪文件：共享 displayColor 含两套 ACES；TS PbrRenderer 已可选，Native 四变体与实际 OutputPass 仍固定 scalar。v1–v9 是能力版本，不是输出模式。
2. 已读 RuntimeSolidEnvironment、LoadedRuntimePackage、PlayerContent、AuthorGrading、CompileSceneRuntimeOptions：六通道已经生产消费；Deep 四通道独立。新字段仅 `environment.displayProfile?`，不改变 Frame/48B 作者 uniform ABI。
3. Cargo/package 已有 serde、wgpu、Vitest、Three 与共享 WGSL，未新增依赖。
4. 已查 compileSceneRuntimePackage→环境内容 hash→Native parser→PlayerContent→Renderer::init→OutputPass 的消费链；所有 LoadedRuntimePackage 构造集中在 payloads，旧 OutputPass factory 保留。
5. 已查 96 组 Native 输出矩阵、Gate D 输出首刀、CPU grading 与实际背景测试；现 inverse_output 固定 scalar，直接切换 shader 会改变作者背景。
6. 已查本日 Native 输出/spec/估时与 recovery ledger。J2-B2 公共数学已经完成，不重建作者参数；本刀只补可选 profile 的真实 wire/host/output 消费。

已有（不重建）：两套公共 ACES、作者六通道、线性曝光上游、四输出变体、透明 alpha、输出 target 编码、加载/内容 hash 与 GPU pipeline。

真实缺口：Native 无可选 Three profile，环境 clear 的逆变换只有 scalar；显式发布选项没有贯通生产。

## 实施合同与验证

新增可选 `displayProfile: "deep-aces" | "three-aces-r185"`；缺省不写字段，旧包字节/hash与默认行为保持。发布编译的专业 API option 消费该字段，不加界面选择器。Native 解码保留已选 profile，初始化为对应输出 pipeline；原 `new`/`output_shader` 保留旧默认。

背景不是 shader HDR 输入的用户数据。Three Color 背景不经 tone mapping；Native 按已选 profile 在加载时逆解相同显示颜色。Three 逆解先反输出矩阵、逐通道解二次拟合、反输入矩阵并还原0.6系数；clamp具有非唯一输入，以目标显示范围0–1中的一组可达输入为准。彩色背景的逆输入可含负 HDR 通道，禁止非负截断。黑色可直接保留零输入。

真实GPU首轮发现纯绿背景在RGBA16F输入量化后零通道出现0.00336075的sRGB泄漏。逆解的0/1端点改选clamp等价输入，余量为最大目标linear通道/1024，对应半精度十位fraction的相对步长；内部目标通道不变，全黑保持0。512组含1e-10暗色与内部颜色的独立CPU往返最大1.18893e-14，八种背景经half输入量化的CPU参考最大误差5.36e-5。shader、target格式和预设0.002门保持。RTX4060/Vulkan真机复跑224组通过，最大误差0.00048828125、GPU错误0。

六通道与曝光语义保持；完整 Three 作者场景照明/雾/后处理等价仍属后继。验证包括显式/省略/非法profile、内容hash、实际parser/host消费、灰色/彩色背景往返，以及真实GPU两profile/四变体与作者分级。Native/Cargo/GPU由主线串行执行，数值门提前固定。

独占文件经主线批准：TS环境合同/校验与发布编译入口、Native profile核及lib声明、环境decode/payloads/types、PlayerContent、Renderer init、OutputPass、Native公共输出shim、新专项测试与本规格；E/D既有helper与其Native测试不触碰。

实现已定稿：发布option写入实际环境payload并参与既有resource/package hash；Native环境decode、LoadedRuntimePackage、PlayerContent与Renderer init传递同一enum，OutputPass在pipeline创建时仅specialize公共shim的一条ACES调用。旧factory装配字节逐字节不变，不修改canonical WGSL、Frame或作者uniform。透明alpha与上游曝光原位置保持。

真实热更新消费补 `requires_content_rebuild`：已选profile不同时走既有完整renderer epoch。黑背景两profile都为0也必须重建，不能仅比较background字段跳过新pipeline。专项actual-window GPU回归覆盖旧帧有效、陈旧incremental更新拒绝、重建后profile消费与有效帧。

TS环境合同/合法分级及发布编译聚焦4文件42测通过；Deep Engine类型检查与主线Web类型检查通过。Rust格式/diff检查通过。Native CPU profile三测通过，包含512组端点/暗色/内部颜色往返。Native target三测通过、实机门一测按既有约定ignore，随后显式执行实际GPU门通过。真实Windows黑背景profile-only热切换一测通过，验证陈旧incremental epoch被拒绝、旧帧仍有效、重建后新profile被实际消费。新增文件按职责拆分：CPU核、Native主target、实际GPU draw helper与window回归均低于300行；不增加体量豁免。专项parser样本替换环境ID后按既有canonical id重排resources，再计算packageHash；生产parser不变。

验证命令：

```powershell
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --lib output_color_profile::tests
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test native_output_profile
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test native_output_profile -- --ignored --nocapture
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --bin deep-engine-native renderer::content_profile::display_profile_gpu_tests::black_background_profile_change_rebuilds_output_epoch -- --exact --ignored --nocapture
```

Native矩阵预设RGBA16F输出误差≤0.002（沿用原门），2轮×2profiles×4variants×14cases共224组，包含八种黑白/灰/彩背景、三组HDR与两档作者分级，alpha精确0.5，GPU错误必须0。CPU背景往返固定1e-12；shader原字节门要求精确一致。clamp不宣称唯一逆输入；GPU验证目标是合法显示域颜色的一组可达HDR解。

实际GPU证据：`test-output/interrupted-0930/native-profile-gpu.log`，224组与alpha检查通过，最大误差0.00048828125，适配器NVIDIA GeForce RTX 4060 Laptop GPU/Vulkan。

CPU证据：`test-output/interrupted-0930/native-profile-cpu.log`，三测通过。实际window证据：`test-output/interrupted-0930/native-profile-rebuild.log`，黑背景profile-only重建一测通过。本刀运行包/加载/背景逆解/host/output消费与热切换完成；完整Three场景光照、雾和其它后处理合同仍按原后继范围。

视觉长期口径按用户最新指令：产品验收仅深色1920×1080；GPU数值fixture保留原32×1读回合同，本刀无界面选择器或产品布局改动。
