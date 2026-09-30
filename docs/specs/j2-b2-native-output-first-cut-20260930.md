# J2-B2-N Native 输出公共数学首刀

四个 Native 输出变体复用 `displayColor.wgsl` 的 ACES 与 sRGB 数学，作者六通道分级保持独立合同。

## 现状核查

1. 已搜索 Native/TS/应用源与未跟踪文件：`OutputPass` 已消费 plain、bloom、fog、bloom+fog 四种输出 shader，不新建输出管线。
2. 已读 `AuthorGrading`、`DirectionalLighting`、运行包 `SolidEnvironment`、TS `PbrAuthorColorEffects` 与能力 manifest。作者 contrast/saturation 的中性值均为 0；`DeepOutputSettings` 中性值均为 1，两者不能直接转换。
3. 已查 Cargo/package 依赖：wgpu 30、bytemuck、现有 WGSL 同步器足够，无新增依赖。
4. 已查消费方：renderer 初始化及 bloom/fog/compact-forward/author-grading GPU 测试消费 `OutputPass`；mesh 在 HDR 输出前应用 `frame.lightingOptions.x` 线性曝光，输出 pass 不再乘曝光。作者 UI/Three 曝光与现有包范围不在本刀修改。
5. 已查证据：作者分级 CPU golden、真实 NVIDIA 分级 GPU 测试、Gate D output-only 两轮 RGBA8 对拍均已存在。当前 GPU 测试仅实际读回 plain；其余变体只编译，没有共同向量消费读回。
6. 已查规格与交接：0930 中断续接已完成 TS 三输出家族单源化。Native 四份重复输出数学与四变体消费对拍仍是真实缺口。

已有（不重建）：48 字节作者分级 uniform、bloom/fog 前置合成、双 target 编码分支、CPU 分级实现、sRGB 背景逆 ACES、线性曝光上游位置。

真实缺口：四处 ACES/sRGB/作者分级重复；Native 未实际 include 共享 displayColor 源；四变体缺同向量 GPU 读回。本刀只补这些缺口。

## 参数语义

| 输入 | Native 既有语义 | 本刀处理 |
|---|---|---|
| exposure | 光照/材质 HDR 上游的线性乘数；不是 EV | 原位置与范围保持，公共 ACES 调用曝光 1 |
| tone mapping | `native-aces-*` 固定 Narkowicz 标量拟合 | 复用 `deepAcesFit`；不切换到 Three ACES 矩阵 |
| author grading | hue/saturation/brightness/contrast/temperature/tint；全零精确中性 | 同一 Native 公共库，原公式与执行顺序保持 |
| Deep grading | temperature/tint/log contrast/saturation；contrast/saturation 1 中性 | 未在 Native 作者 uniform 中启用，不合并两个合同 |
| Bloom / Fog | HDR 合成在作者分级与 ACES 前 | 保持原变体操作 |
| sRGB target | shader 返回线性 ACES，attachment 编码一次 | 保持 |
| unorm / float target | shader 显式 sRGB 编码一次 | 复用 `deepLinearToSrgb` |
| alpha | HDR alpha 直接输出 | 保持 |

## 实现与验证

设计读取采用 `design-taste-digitaltwin`：本刀目标是保持现有场景外观与调节自由度，不修改界面布局、品牌令牌、雾与光照美术参数。数学一致性用真实读回验证；整场景截图与十维视觉验收留到完整画质验收。

`output_shader()` 在管线创建时装配共享 displayColor、Native 作者分级库与对应变体；不在每帧拼接，不新增 uniform、pass 或纹理。共享标量 ACES 抽函数属于后继有意源码变化，0930 前刀的字节保持证据仍只适用于此前迁移。

实现已定稿。四个变体的作者分级块与 HEAD 逐字节一致（LF 归一化），SHA-256 `3f9b4780907d1598995ab5fb1220f7d2be974f4854a7ee3d545bae7caeae745d`；各变体的 HDR 合成/采样/fragment 主体仅移除公共函数块，其他字节保持。Rust 格式与 `git diff --check` 已通过。

专项 GPU 测试增加两轮 × 三组 HDR × 四档分级 × 四变体，共 96 组比较。参考值来自既有 CPU 作者分级与提取前 Native 标量 ACES/sRGB 公式；Rgba16Float 阈值沿用原探针的 0.002，跨变体与跨轮要求精确一致，alpha 精确保持 0.5。Bloom/Fog 在共同数学矩阵中强度/密度为 0，启用效果由既有独立 GPU 测试覆盖。

主线串行验证已通过：输出公共源合同2项、mesh ABI 4项、bloom合同5项，共11 passed。真实 NVIDIA RTX4060 Laptop / Vulkan 探针1项通过，96组比较的CPU最大误差0.00048822165，跨变体差0、alpha差0，重复两轮精确一致，GPU错误0。日志为 `test-output/interrupted-0930/output-native-contract.log` 与 `output-native-gpu.log`。首刀已验证；整场景与可选参数范围保持后继状态。

首次合同回归发现 `native_mesh_abi` 的旧断言仍期待 `energy_compensation * ambient_occlusion`。现有 J2-B3 白炉修复已先将补偿纳入 `specular_fraction`，再将同一分数用于漫反射储备和镜面交付；断言改为同时锁这三条生产公式。J2-B1 公共直射 BRDF 由 `frame_bindings` include；此项 IBL 分配仍在 mesh 主体，未因公共 BRDF 迁移而移走。既有 CPU 白炉和真实 GPU 球/墙腿保持。

GPU 矩阵按职责拆入 `tests/support/native_output_color_matrix.rs`，仍调用原测试目标的真实 `draw_variant` 与纹理输入工具；半浮点转换工具单独位于 `tests/support/native_output_half.rs`。主测试文件低于 300 行，测试名与运行入口保持，不新增体量豁免。

后续仍有完整 Native/TS 参数开放、Three ACES 可选运行包合同、完整后处理/几何/深度/阴影对拍；本刀不据此记 J2-B2 全项完成。
