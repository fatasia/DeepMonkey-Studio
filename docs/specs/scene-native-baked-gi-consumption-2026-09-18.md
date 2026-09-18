# Native 烘焙 GI 消费验证（2026-09-18）

真实烘焙 GLB 的 UV1 与间接反弹能量已通过既有 Native 作者模型导入、编译和渲染链。后续同日复测已消除明显结构色块，仍有细颗粒噪声；下文保留原证据和修正前后记录。

## 证据

- 使用原 `lightmapBaker` 生成的 64 样本、降噪、三面房间 GLB。GI-on SHA `74eef9fb240a1a9596a63a87f1f7f3ddf6a773c8ed49aca3fbd661add0d488fa`；off SHA `41d7a04fb38f8e3e8660f4cb14b7fe1bbdea89ef234e270b7a3b823064459ef8`。
- 复用 `compileNativeSceneCandidate` 与生产 `captureNativePlayerWindow`，没有单独 GI 渲染路径。编译包包含真实 emissive 纹理、`texCoord:1` 和几何 `uv1`。Native 继续消费既有 emissive factor/strength；此房间实际材质 strength 为默认 1，不把它当作 >1 强度回归证据。
- 两组相机相同，IBL 为零，只有相同弱参考点光；唯一变化为冻结 GLB。各运行两次，客户区分别逐像素一致；on/off 差异为 270039 个颜色通道。
- `test-output/native-baked-gi-20260918-r2/evidence.json` 保存 EXE、GLB、运行包与四次客户区哈希。脚本：`scripts/verify-native-baked-gi.mts`，验收脚本类型检查通过。

## 跨端阈值矩阵（2026-09-18 新增）

`scripts/verify-gi-crossend-matrix.mts` + `apps/web/scripts/gi-crossend-page.ts`：同一烘焙 GLB（round-1-gi-on/off）、完全同口径（fov 25、方向 (6,4,7)、center (0,1.5,0)、fit 1.05、点光 2@(1,4,3) decay 2、ACES、背景 #172126）下，真实 Chrome WebGPU（three.webgpu）与 Native 窗口读回（PrintWindow）成对采图，`renderImageSimilarity.mjs` 统计并输出差异图。证据 `test-output/gi-crossend-matrix-20260918/`（matrix.json、web/native/diff PNG）。

首轮数字：GI-off 格 SSIM 0.238 / MAE 0.077 / PSNR 21.7dB；GI-on 格 SSIM 0.063 / MAE 0.175 / PSNR 12.3dB。差异图定性：**几何/相机/装机完全对齐（差异图无边缘错位）**；残差为两类——①GI 受照面整体亮度标度差（引擎间光照单位/求值语义差异）；②烘焙噪声纹理形态差（64 采样档已声明细噪声）。背景区域差异接近零。

结论与边界：不能把 p08 dashboard 的全局 SSIM≥0.970 阈值直接搬到 3D GI 场景——全局单窗口 SSIM 对亮度标度差过敏。终门 GI 阈值口径建议：分窗口/边缘带结构 SSIM + 曝光归一化 MAE，噪声区按 expected 标注；该口径设计归 WebGPU 客户端 vs 网页端全量终门统一裁决，本矩阵提供其数据基础。Web 侧点光按 three 物理光照语义（candela、decay 2）与 Native 合同参数对齐，残余亮度标度差本身即为待收敛的引擎一致性缺口。
- 初次零动态光对照因只有少量平色，被通用截图 8 色空白门槛拒绝。没有改低门槛；复测使用两组相同参考点光来保留足够梯度。

## 视觉结论

查看 `gi-off-1.png` 与 `gi-on-2.png`：真实红墙反弹已进入地面与后墙，三面几何完整、无裁切；目前仍可见三角/多边形色块。消费链通过，GI 视觉终验未通过。此处不新增其他 GI 路线，后续质量修正回到原 baker。

按 design-taste-digitaltwin 两轮实窗核验，参照 Unity 的烘焙间接光目标。10 维自评：布局 9、令牌来源 9、既有排版 9、状态稳定性 9、3D 光照质量 7、尺寸稳定性 9、语义 9；动效、信息设计、交互时延本项不涉及。色块改善前不将本场景计为高质量画面完成。

## 色块来源定位

`scripts/inspect-gi-texture-evidence.mjs` 直接从同一 `74eef9...` GLB 的 bufferView 抽出原 PNG，没有重烘焙或缩放。`test-output/gi-texture-inspection-20260918/image-1.png` 是 emissive texture 实际引用的 image，原图已存在和 Native 后墙/地面相同的三角、多边形色块。

- 原 PNG 解码 RGBA 与 Native runtime 包对应 texture.data 逐字节哈希相同：emissive `91f1a00212c32418c5799924e4b52fcc6734a59390b93cc466fe6b4239370c8b`；occlusion `3b874d3ba46c638fc3094f8e92fb744ca974893873f8885f54e23760f9b6311b`。
- 三个网格的 GLB TEXCOORD_1 Float32 accessor 和 Native geometry.uv1 逐值相等，检查 byteOffset/byteStride，不用元数据声明替代真实字节。
- Native `native_mesh_v1.wgsl` 的 uv1 是默认 perspective 插值，material flags 是 flat；emissive 采样使用 UV1 与线性 sampler。`pbr_texture.rs` 将 emissive 定义为 sRGB，`gpu_texture_types.rs` 上传为 Rgba8UnormSrgb，未见把自发光错误当线性纹理的路径。
- 原 Three 图使用方向光强度 2 与 IBL 0.2，Native 消费诊断使用弱点光与零 IBL，照明并不等效。额外底光降低源纹理色块对比是合理解释，但本次没有做等效照明对拍，不能宣称两端整体没有差异。

直接证据将当前大块图案定位到烘焙输出；`lightmapIndirect.ts` 对所有点复用相同有限半球方向，遮挡命中在空间中形成相关区域，是下一步修正对象。不通过提高样本数或改 Native sampler 掩盖；源烘焙改进由主线负责，旧 GLB 与证据保留。

## 固定样本数旋转后复测

主线将半球方位按世界位置作确定性旋转，仍为 64 样本与原降噪。新 GLB SHA `ecb4521af51c79776b4ef8d9fa75eaa9f03e251b7065da9594875b1f3b4da13b`；复用原冻结 EXE、相机、弱点光和零 IBL，没有更改 Native 渲染器或增加底光。

- 源 PNG `test-output/gi-texture-inspection-rotated-20260918/image-1.png` 的大块三角/多边形图案变为连续色溢渐变与细颗粒噪声。Native 两轮原始截图显示同样改善，地面、后墙结构色块明显消除；近看仍存在残余细噪声。
- 新 PNG 解码与 Native texels SHA 相同：`b5dddb1873e2c4888f2228cba9f69f87a4e5ade9c4d3685a18f12b0e5a6049ca`。AO 图未改变，三个 UV1 accessor 对拍继续通过。
- `test-output/native-baked-gi-rotated-20260918/evidence.json`：同一 EXE SHA 与旧证据一致，GI-off 客户区 SHA 与旧证据一致，GI-on 两轮客户区 SHA 均为 `df3e268772cb424385a05e1eb4131412ac031c858f484352b7b16c42671846b3`；on/off 改变 270039 通道。
- 该结果支持结构色块来自相关采样方向的判断。当前简单房间改善不代替复杂几何、多个 UV 岛、材质/遮挡矩阵及正式跨端相同照明阈值验收；不据此将 Engine 或完整 GI 目标全部关闭。
