# I-C23 分层白炉归因（2026-10-01）

分层白炉 G/B 首跑超差来自测试参考的混合域错误；生产层混合合同无需改写。GPU 与 Cargo 由 root 串行运行，本刀不放宽既有 2% 均值 / 8% 峰值容差。

## 现状核查

1. 全仓 `packages/*/src`、`apps/*/src` 搜索 layered / deepLayerBlend / blend_layer_stack 命中 62 个文件；未跟踪仅四受保护项。Native GPU 白炉唯一入口是 `src/renderer/white_furnace_gpu_tests.rs`，通过 bin 父模块挂载；不存在第二份分层白炉实现。
2. 已读 contracts 能力清单、TS `renderPacketTypes.ts` / `materialLayeredSurface.ts`、Native `contract/types.rs`：baseColor 为线性因子，层颜色、coverage、mode 与 304B 块已有，响应级 overlay 合同明确为 `coverage × clamp(layerRgb, 0, 1)`。无需新合同。
3. package.json 与 Cargo.toml：Node、Vitest、wgpu 30.0.1、serde_json、bytemuck 已在用；无新增依赖。
4. 消费方：Web `pbrLayeredMaterialShader.extendedShade` 和 Native `deep_layer_stack` 均独立求父材质响应，再将该响应同时传入混合值和 overlay 权重。`scene_pack.rs` 与 `pbr_layered.rs` 颜色因子逐值上传，无 sRGB 转换；本 fixture 没有纹理。Web lab 已用独立父材质 HDR 帧算 oracle，Native 新腿尚未沿用。
5. 已读 Native 白炉 CPU / GPU 与 `pbr_layered` 测试、TS layered production lab、J2-B3 报告和实际 GPU 日志；既有白球 / 白墙两腿全绿；Web production 两 fresh 父材质 oracle 已验。Native fixture 的 `furnace.blended` 验的是输入本身作为响应的纯混合数学，不能直接当彩色材质出射辐亮度。
6. 已读 GLM handoff、I-C23 production / native-consumption 两规格、remaining 表、恢复台账；真实断点是 Native 分层新腿 G/B 超差。RT 分层管线族缺口仍保留，不与本腿归因混算。

**已有（不重建）**：双端层响应消费、304B ABI、共享混合核、CPU 金标、Web 父材质真帧 oracle、Native 白炉渲染和回读、2% / 8% 唯一容差源。

**真实缺口**：Native 分层 GPU 测试将 albedo 混合值乘 E 作为响应参考，缺普通父材质逐像素独立 oracle 与零覆盖逐位身份断言。

## 根因

旧测试计算 `E × blend(baseAlbedo, layerAlbedo)`。生产计算 `blend(parentResponse, layerResponse)`，overlay 的权重取后者，因而 `E × blend(A, L) != blend(EA, EL)`。replace 为线性固定权重，单独使用时可交换；overlay 不可交换。

在 fixture 的 E=0.5、base=[0.9,0.9,0.9]、overlay=[1,.4,.2]×.75、replace=[.6,.9,.3]×.5 下，即使先忽略镜面项：

| 参考 | R | G | B |
|---|---:|---:|---:|
| 旧 albedo blend × E | .393750 | .412500 | .273750 |
| 先乘 E 再响应混合 | .384375 | .431250 | .286875 |
| 相对旧参考 | −2.381% | +4.545% | +4.795% |

G/B 方向和幅度已经解释旧失败；默认 ior=1.5 还携白色镜面项。stock IBL 的彩色父材质响应是 `E × [(1−s) × albedo + s]`，不是 `E × albedo`。s 随视角 / DFG 采样变化，因此应使用同几何、同环境、同像素的普通父材质帧作为独立参考，避免另一套采样近似。

这不是 sRGB / linear 混合差：两侧层因子直接上传；fixture 不采样纹理；混合唯一真源与调用参数一致。

## 修复方案与文件锁

独占 `packages/deep-engine-native/src/renderer/white_furnace_gpu_tests.rs`；公共 WGSL 不改。root 正运行全源哈希门期间，仅写此规格和独立 CPU 归因脚本，等明确解冻才改 Native/src。

1. 渲染 base 与各层的普通材质父帧，使用同 geometry / frame / builtin LUT / E。
2. 对每个像素用独立 f64 闭式混合父帧响应，overlay 权重来自对应父层 HDR 值；逐通道均值、逐像素误差继续用既有 2% / 8%。
3. 逐像素逐通道验证不超父响应凸包，保留同容差与白炉绝对能量上界。
4. coverage=0 的 layered 帧对普通 base 帧逐位比较；独立白色父帧仍验证炉能量守恒，不把父帧漂移吸收为正确。
5. GPU 主线运行两 fresh；记录真实命中数量、数值与设备结果。

精确命令：`cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --bin deep-engine-native white_furnace_layered_stack_matches_cpu_convexity -- --ignored --nocapture --test-threads=1`。旧两腿另用同 bin 的 `white_furnace_ -- --nocapture --test-threads=1`，分层 ignore 不会隐式执行。

## Design Read 与验收边界

对标 Unity 的 PBR 能量 / 材质响应和西门子的工业数值语义；沿既有炉环境与材质生产管线，不增加 UI / 色令牌。已加载 design-taste-digitaltwin。本刀交付测试归因，尚未完成新分层视觉两轮，不能据 CPU 推导宣称 I-C23 完成。UI 布局、排版、交互、动效、响应式维度不适用；3D / 数值维度待真机证据评分，不凭推断给分。

## 验证记录

root 解冻后实现已冻结；`node scripts/i-c23-layered-furnace-attribution.mjs` PASS，验证响应域预测、replace 可交换而 overlay 不可交换、0..1 镜面分数下炉上界；`rustfmt --config skip_children=true --check` PASS，`git diff --check` PASS。Native Cargo 编译与 GPU 结果待 root 串行执行，原 G/B 失败与原容差保持记录。

2026-10-01 root 在 RTX4060/Vulkan 两次独立进程各建1 fresh设备实跑通过（单次命令只有1 fresh）：每轮65536几何点，layered均值 `[0.385986,0.431649,0.289101]`，独立预测 `[0.385994,0.431807,0.289198]`，最大相对误差0.0583%；coverage0逐位恒等。原墙/球两腿也实际通过，球几何平均误差−0.021%、最大0.049%，墙零误差。日志 `test-output/jc-i-20261001-layered-furnace-round{1,2}.log` 和 `jc-i-20261001-furnace-regression.log`。数值维度已验，完整分层产品仍保留。
