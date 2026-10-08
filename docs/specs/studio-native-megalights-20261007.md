# Native MegaLights 生产表面与可见性（2026-10-07）

补齐已在帧循环调用的 RIS 链，先核对真实着色输入，再验证硬件遮挡与计光。

## 现状核查

1. 全仓源码与未跟踪文件：已查 packages/apps MegaLights、GBuffer、visibility、ray query，核对 git status。renderer/megalights_gpu/runtime 以及 bin 生产探针已有在途成果；避免重建 lib RIS 核。
2. 契约：64B 灯池、3 vec4 表面行、DeepMegaParams 64B 和可见性槽已存在；Native Mesh 已返回真实 normal/rough/base/metal，纹理/UV/法线与 alpha MASK 已有正式消费。无需改用户场景合同。
3. 依赖：wgpu 30.0.1、pollster、bytemuck、硬件 Ray Query 与驻留 BLAS/TLAS 已固定并在用；不加依赖。
4. 消费方：frame.rs opaque 后调用 GPU RIS；rt_residency.tlas 已在 RT 阴影使用。当前重建核固定中性材质、deepMegaVisibilityAt 恒 1，CPU winner_visibility_mask 已有但没有生产 GPU 消费。
5. 测试/证据：lib CPU/GPU 对拍已存在；bin 生产链镜像探针为 neutral surface、visibilityEnabled=0。外部《执行 Deep Native 列恢复》已完成且 idle；其正式 12 轮基准不改，bin 测试有 rand_chain mut / rand_config move 两处编译缺陷。
6. 规格：已读 studio-handoff 13:36 §4、studio-quality-continuation、native bench resume 与 recovery ledger 关键词、contracts capability manifest（仍 harness-only，不能提前提升）。

**已有（不重建）**：RIS/IES 单源、灯池打包、矩阵/预算、生产重建→build→shade→合成、真实 PBR 着色与 RT TLAS、CPU 胜者可见性。

**真实缺口**：实际表面 GBuffer、GPU 胜者 TLAS 可见性、避免簇光与 RIS 重复计光、首帧 EMA 与 stale history、两处探针编译错误、大文件拆分及新的真实 GPU 证据。

## 计划与边界

复用真实 mesh 材质/法线求值，保持默认关闭和 auto 预算内零新增帧成本。无有效表面或 TLAS 则保留完整簇光并披露降级；资源设备拒绝不接半链。GPU 验收等 React RT、cluster 两路结束后串行，CPU 检查先行。对标为项目的 Unity 显式 PBR 与可见性语义，验收看实际 GPU 输出和能量，不以源码注释当证据。

## 已落地

- `megalights_gbuffer.rs` 复用主帧材质纹理、UV、normal map、实例、间接剔除/LOD；Equal 深度再绘不改主深度，真实 base/metal/normal/rough 进入 RIS。
- `megalights_inputs.rs` 用主深度重建视空间位置；build 后逐像素 winner 执行 TLAS Ray Query，shade 消费实际 visibility；遵守 light castShadow 与 instance receiveShadow。
- GPU 有序 uniform copy 在 opaque 前关闭旧局部光，透明前恢复；透明场景加性合成同时更新 MSAA 与 resolved HDR，防止后续 resolve 覆盖 RIS。作者 exposure 同步乘入合成。
- 首帧、相机/灯池/阴影选择/场景内容/视口或 TLAS 换代清历史；稳定帧无重复 GPU error-scope 同步等待。
- 缺 TLAS、自定义/分层材质、含 MASK 保守 TLAS、TLAS 含禁用投影的 opaque 实例、非点/聚局部灯或资源超预算保持原簇光并披露拒因；默认 off，auto 预算内无 GBuffer 构造。
- GPU 资源/模板/数学/编码/绑定、灯池与运行时职责拆开；原 1146 行 probe 去掉重复 GPU 建链并拆 fixture/readback；init RT 初始化独立提取，保留初始 preparation clock 和既有 observer。

## 检查与边界

CPU 聚焦 15 tests 已通过（`test-output/studio-native-megalights-cpu.log`）。RTX 4060 Vulkan 实际 GpuScene + GBuffer + TLAS 已通过：base=[0.119995,0.419922,0.779785]、metal=0.649902、rough=0.298039；遮挡 mask=0/RGB=0，移灯 mask=1/RGB=[0.014003,0.047955,0.088692]。castShadow=false 保留光贡献，透明 resolve 后 RIS 仍在，局部灯计数恢复。

DX12 同 RTX 4060 的 wgpu feature 未暴露 Ray Query；真设备断言 TLAS MissingFeature、保留簇光与零 RIS/GBuffer 分配通过。Vulkan 证据为 `test-output/studio-native-megalights-vulkan.log`，DX12 回退证据为 `test-output/studio-native-megalights-dx12.log`。半分辨率上采样之后两条检查已重跑通过（Vulkan 1.66s；DX12 回退 3.71s）。

本切片保持 RIS/IES 单源；stock 完整 PBR 的多次散射、特殊 IOR、雾和高级材质响应尚未与 RIS 定标，默认门控不提升。Native 作者池仍最多 16 盏，auto 不触发万灯腿。

256MiB 总 scratch 上限保持：720p 全尺寸 RIS；1080p 保留全尺寸材质 GBuffer/深度，RIS 960×540，192,848,896B（183.91MiB）。奇数尺寸按向上取整，resize 对原尺寸+epoch 判定；4K 仍明确回簇光。双线性上采样过滤深度/法线/base 色不匹配源，无有效源贡献零，避免轮廓跨面漏光。

实际 1080p Vulkan 检查通过，硬件链 2.33s（含构造与 readback，非每帧 GPU 时长）。真实材质 metal=0.649902、rough=0.298039，中心 mask=1、RIS RGB=[0.014953,0.051101,0.094473]；透明 resolve 后仍有贡献，背景与清屏值一致。证据：`test-output/studio-native-megalights-1080p-vulkan.log`。该探针验证资源/语义，连续帧性能定标与任意材质轮廓边界的误差仍待独立基准。

## Release 构建身份

`cargo build --locked --release --bin deep-engine-native -j2` 已通过（4m45s；日志 `test-output/studio-native-megalights-release.log`）。源码清单含 Native、geometryDag 与共享 WGSL 共 1255 文件，SHA-256 `e9eced451cce06cc47285785c63e5ebc84e63659df33cf6135a6e75932431a0e`，与构建前冻结一致。EXE 21,899,776B，SHA-256 `6386937c416781f289fbeda3316fa12f49f9ead28c11586e3257840caf041c68`。完整身份为 `test-output/studio-native-megalights-identity.json`。

这版 Cargo 版本为 0.1.0，是本轮验证产物；主线程统一升级 0.2.0 后再增量构建并重算身份，发布包采用最后版本。编译期间的数据不作干净性能定标。

最终归档入口为 `scripts/export-release-native.mjs`：`-j2` 构建前后核对共享 Native/WASM 完整来源指纹，含 Native 资源与 geometryDag；核对 EXE 的 AMD64 PE、主版本，再打包许可证和 `BUILD-IDENTITY.json`。最终构建固定 `crt-static`，C runtime 内置，离线机器无需另装 VC runtime。脚本语法检查通过，0.2.0 构建等待性能窗口；尚无最终 EXE/ZIP 身份。

## 发行体量门现状核查

1. 源码与未跟踪文件已复查：MegaLights 中性镜像 probe 476 行、shadow_dirty 306 行，Deep 专用 sourceSizeGate 对新增/扩大的文件执行 300 行门；全仓 800 行门不足以代替它。
2. 类型仍复用既有 MegaSurfaceRow、wgpu 资源、RenderPacket 与 ShadowCasterSet，没有新的公共合同。
3. Cargo 依赖不变；hash 与 GPU fixture 库均已在用。
4. bin renderer 在 cfg(test) 引入 probe；Native 主入口与 WASM 显式引用同一 shadow_dirty，必须保留模块路径与可见性。
5. 既有实际 GPU probe 和 shadow_dirty_tests 已覆盖相同断言；本次只迁移测试目标初始化/断言及私有 HashWriter，不改阈值、编码顺序或哈希字节。
6. 已读 ENG-source-size 拆分记录与本轮交付规格。拆分会改变共享来源指纹，完成后须协调主线程更新 WASM 工件身份，再构建最终 Native。

**已有（不重建）**：全部测试断言、GPU 目标配置、影子缓存与资源摘要算法。

**真实缺口**：两文件职责叶超过 300 行；按目标初始化、结果断言、哈希写入拆分，保持行为一致。

拆后 probe 主文件 300 行、targets 125 行、assertions 75 行；shadow_dirty 225 行、hash_writer 87 行。bin 测试编译通过，shadow_dirty 5 tests 通过、1 独立 CPU benchmark 保持 ignored；Deep 专用体量门 failures=0。证据：`test-output/studio-native-release-size-tests.log`、`test-output/studio-native-release-final-size.log`。已通知主线程重建 WASM 更新来源指纹，最终 Native 静态构建在该构建之后执行。

拆后补跑旧中性 GPU oracle 发现随机 `m` 逐位断言失败：GPU 12、CPU 11。原 CPU 输入 motion_uv=None，会跳过历史候选，GPU 的既有零运动缓冲会同像素重用历史；同时 CPU 使用解析 f64 表面，GPU 使用 MSAA 重建 f32 表面。随机 CPU oracle 改用同一零运动与已读回的 GPU 表面；解析表面的 0.002 误差门与全部 winner/m/颜色断言保留。此修复只改测试，生产 RIS 不变，聚焦 GPU 复查中。

同输入修后随机 winner/m 与颜色门已过，继续发现旧合成 oracle 只预期最后一次贡献，但目标从首帧保留内容、四次 encode 都加性写入。现在在随机链之前读取两帧合成目标，用两份实际 RIS scratch 与每次 f16 舍入计算独立期望；全部像素（含 MSAA 过渡带）都检查，alpha 与 0.01 误差门不变。

最终中性 kernel oracle Vulkan 通过：192 像素，surface 最大误差 0.000558、两帧穷举颜色最大误差各 4.3273e-5、合成最大误差 0.000977；随机 winner/m 逐位、随机颜色 RMSE 门同时通过。用例 0.72s 含设备创建和 readback，非帧时。日志 `test-output/studio-native-release-size-gpu.log`；此 kernel oracle 与前述真实材质/TLAS 生产证据各司其职。拆分后主 probe 299 行，shadow_dirty 225 行，来源已冻结。

## 最终 0.2.0 Windows 归档

静态 CRT release 构建 6m41s 完成，来源前后指纹一致：896 个输入、SHA-256 `d78a98de37cc5942b510a6730cb277c20f863c73b7a74f3100ed9237a0c048bd`；Native Cargo.lock SHA-256 `6e52d2e133099fe49751719d44bc737e8916f50b879fa7e161d38c5245db2365`。EXE 位于 `packages/deep-engine-native/target/x86_64-pc-windows-msvc/release/deep-engine-native.exe`，22,116,352B、SHA-256 `81fca0d3218d5de106eeebe792a87457ceea9c3abbc1d36beee935e9daaa7347`。

实际 PE 导入表仅有 Windows 系统 DLL，没有 VC runtime/动态 CRT。`--help` 与既有运行包 `--headless-package` 在这份发行 EXE 上均 exit=0；保留旧版本运行包的兼容性。日志 `test-output/studio-native-020-static-release.log`、`test-output/studio-native-020-static-cli.log`。

`artifacts/releases/0.2.0/DeepMonkey-Native-0.2.0-windows-x64.zip` 为 8,374,758B，SHA-256 `239cc3f600cb5e5d311050a2a6a499cbaf2f815fee6b4c98e3b8caad63d92c43`，内含 EXE、BUILD-IDENTITY.json、用法和许可；旁 JSON 记录实际源身份、DLL 导入及构建设置。build revision 记录构建时基线 HEAD，实际未提交源码以来源指纹为准；最终 Release 提交由主线程统一执行。
