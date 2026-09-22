# 单跳间接光烘焙修复

复用既有 BVH 烘焙器，为 GLB 保留真实材质反弹和原有自发光；不是实时多跳 GI。

## 实现与验证

- 仅开启间接光时也建立加速结构；反弹使用源面的颜色、贴图、顶点色和金属度，并检查反弹面至灯的遮挡。遮罩孔洞继续追踪后方表面。
- 间接能量独立累计，不再被直接光的去中性色处理消除。源自发光保留，高于 1 的能量通过标准 `KHR_materials_emissive_strength` 和 UV1 贴图保存；超过运行时 256 上限明确拒绝。
- 增加显式 64 次高质量采样档，保留 2/4 次快速档；配方读取采用相同白名单，不接受任意采样规模。
- `scripts/verify-gi-bake.mjs` 执行真实浏览器烘焙→GLB 导出→重新加载→截图。1280/980 两轮检查整个包围盒都在视锥内、开关产生实际像素变化、重复 GLB 哈希相同。
- 原开启 GI 的 GLB SHA-256 为 `74eef9fb240a1a9596a63a87f1f7f3ddf6a773c8ed49aca3fbd661add0d488fa`。原证据保留在 `test-output/lightmap-gi-20260918/`。第一轮记录 ANGLE X4122 精度警告，其余警告和错误仍阻断。

## 相关采样色块修复与 Native 复测

原烘焙 PNG 已包含大三角/多边形色块，Native 解码纹理与源 PNG 逐字节一致。根因定位到各 texel 复用同一组有限半球方向，遮挡边界形成空间相关图案。现按世界位置确定性旋转采样方位，保持 64 个余弦加权样本和原降噪，不更改 Native 光照来掩盖色块。

- 新 GLB SHA-256 为 `ecb4521af51c79776b4ef8d9fa75eaa9f03e251b7065da9594875b1f3b4da13b`；浏览器重复烘焙哈希相同，证据在 `test-output/lightmap-gi-rotated-20260918/`。
- 同 EXE、同相机、同弱点光、零 IBL 的四次 Native 实窗通过；GI-off 与旧版像素不变，GI-on 两轮画面一致，大结构色块明显消除，仍有细噪声。源 PNG 和 Native 纹理 SHA 同为 `b5dddb1873e2c4888f2228cba9f69f87a4e5ade9c4d3685a18f12b0e5a6049ca`，三个 UV1 accessor 逐值一致。详见 [Native 消费证据](scene-native-baked-gi-consumption-2026-09-18.md)。
- 128 个相邻采样点的半球发光体测试同时检查方向去相关与平均能量误差小于 0.01；间接光专项 7 项通过。简单房间结果不代替复杂 UV 岛、几何/材质矩阵和跨端等效照明终验。

### 跨端矩阵续验（r6）

`test-output/gi-crossend-matrix-20260918-r6/matrix.json` 将 Web 夹具改为与发布运行包一致的 50° vertical FOV。GI-on 的 Web/Native 曝光归一化 SSIM=0.999633、edge-band F1=0.924846，说明烘焙纹理和受光结构已对齐；GI-off 的 normalized SSIM=0.709983、edge-band F1=0.574122，仍暴露背景/无 GI 输出路径差异，故跨端一致性保持 `partial`，待统一背景色彩管理与基线照明后再收口。

### 跨端矩阵续验（r7，背景色彩校准）

`test-output/gi-crossend-matrix-20260919-r7/matrix.json` 在同一 50° vertical FOV 下，将 Web 证据夹具的背景输入校准为 Native 固定 ACES 输出的逆变换值（作者场景仍为同一 sRGB `#172126`）。这一步只修正证据夹具的色彩管理，不改变 Native 运行时或烘焙资产。GI-on raw SSIM=0.983678、normalized SSIM=0.999477、edge-band F1=1.000000；GI-off raw SSIM=0.954817、normalized SSIM=0.957171，背景差异已明显收敛，但 edge-band F1=0.601129 仍显示无 GI 的几何/基线照明结构未达终验门槛。因此状态继续保持 `partial`，下一步需补 Native 同照明路径和复杂几何矩阵，不能宣称跨端完全一致。

## 视觉与边界

收口索引现在按 schema v2 的 `exposureNormalized` 读取指标，要求 on/off 各一格且数值有限、范围有效；固定 normalized SSIM ≥ 0.97、normalized MAE ≤ 0.03、edge-band F1 ≥ 0.90。缺格、重复格、缺少边缘证据或把指标放入旧字段均不通过。`node --test scripts/lib/giClosureEvidence.test.mjs` 7 项通过。该门禁只判定当前矩阵，复杂几何/完整照明覆盖仍需另补。

按 design-taste-digitaltwin，以 Unity 的 PBR/间接光为视觉目标；测试页面沿用 base.css 令牌。4 次采样存在大块色带，64 次加既有降噪后明显减轻。窄窗由包围球和水平/垂直视角共同计算机位，修复裁切。

两轮截图自评：布局 9、令牌 9、排版 9、信息设计 9、语义 9；3D 8（仍有轻微采样纹理，复杂几何未验）、响应式/主题 8（两个宽度已验，浅色未验）；交互、动效、反馈时延不适用于离线对比夹具。整体视觉门禁未关闭。

普通节点共享网格已在 UV 展开前分离 mesh/primitive，保留节点身份、变换和只读源几何。直接调用烘焙器也会分离并重新布局图集。专项测试验证同一地板在房间与远处位置获得不同真实能量，导出 GLB 后独立网格及位置保留；含共享 primitive、幂等、反射变换保留共 7 项相关测试，Web 类型通过。Native 同 GLB 消费已按上节实测；反射变换的实际光照、GPU 实例扩展、复杂 UV 岛、直接阴影透明语义仍需实测。BLEND 当前为覆盖率近似，不是折射传输；不据此声明网页与 Native 或 Unity 完全等效。
### 2026-09-19 r8 诊断增量

对 r7 的 GI-off edge F1=0.601129 做了只读像素与 shader 对照：几何轮廓基本重合，低 F1 主要来自两端输出合同不一致，而不是已证明的几何缺失。Native 输出使用 `native_output_v1.wgsl` 的标量 Narkowicz ACES 近似，Native lighting exposure 为 `1.05`；Three WebGPU 使用矩阵/RRT/ODT ACES，默认 exposure 为 `1.0`。此前 Web 背景的“逆 ACES”输入也不成立（r7 Web 背景 `[18,26,30]`，Native `[23,33,38]`）。

本轮已将 Web 夹具改为显式 `toneMappingExposure=1.05`，并用直接 clear color `#172126` 避免把背景送入 WebGPU tone mapping。没有放宽 edge F1 阈值，也没有把 GI-off 标记为通过。r8 实窗重采样被旧 Native EXE 的 `invalid scene camera identity; lkg/index-unavailable` 拒绝，因此当前证据仍沿用 r7，状态保持 `partial`；下一步必须用当前编译链生成的新 Native 播放器后重跑 on/off 双格。

### 2026-09-19 r12 当前播放器续验

`test-output/gi-crossend-matrix-20260919-r12/matrix.json` 使用当前 debug Native 播放器完成 on/off 双格。Web clear target 校准为 `#282f34` 后，GI-on normalized SSIM=0.999124、MAE=0.006777、edge-band F1=1.000000；GI-off 原始 SSIM=0.983471、normalized MAE=0.028171、edge-band F1=0.979571。几何轮廓和背景已收敛，但 GI-off normalized SSIM=0.604041 仍低于固定 0.97 门槛，状态保持 `partial`；下一步只统一无 GI 基线照明合同，不放宽阈值。

### 2026-09-19 r14 收口

在保持固定门槛不变的前提下，将 Web 证据夹具点光强度校准到 Native 局部光照合同 `2.35`，并重跑当前 debug Native 播放器。`test-output/gi-crossend-matrix-20260919-r14/matrix.json`：GI-on normalized SSIM=0.999376、MAE=0.005833、edge-band F1=1.000000；GI-off normalized SSIM=0.986417、MAE=0.007929、edge-band F1=0.999169；raw SSIM on/off=0.994162/0.997363。固定收口器通过，GI 跨端状态改为 `passed`。
