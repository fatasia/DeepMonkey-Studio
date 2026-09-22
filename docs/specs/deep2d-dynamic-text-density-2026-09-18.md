# 动态图表文字按实际显示倍率栅格化

用于 Native 图表的坐标轴、图例和 tooltip。静态 Dashboard 文字图集由 producer 密度切片处理，不在此重复实现。

## 根因与实现

原路径按逻辑字号生成 1x RGBA，再经 letterbox 放大。例如 960×540 画布在 1200×800 客户区的有效倍率为 1.25，Windows DPI 已包含在物理客户区内，不能再乘一次 1.25。

保留 cosmic-text 0.19 的逻辑 Buffer、换行和 glyph 布局，用其 `LayoutGlyph::physical(offset, scale)` 在目标像素尺寸栅格化；图片源矩形使用物理尺寸，目标矩形保持原逻辑尺寸。继续灰度覆盖率和 straight-alpha RGBA/Linear sampling，不改成 nearest，也不把 ClearType 子像素颜色放进透明图集。

Swash 原生 key 包含字体 face ID、glyph ID、物理字号、weight、subpixel 和 flags。字体库由独立 TextRasterizer 持有，缩放不会复用另一字号的 bitmap；不引入跨字体库的全局缓存。原 1x raster API 不改变含义。

普通窗口初始、Resized/ScaleFactorChanged 和新包进入后按 `LetterboxMapping.scale` 更新文字。Dashboard 在候选事务中重建、实际 present 成功后提交倍率；失败/零尺寸呈现保留旧内容。独立图表沿既有 stage→publish 原子资源事务更新。零客户区不发布倍率，非法/超 2048px 物理栅格拒绝且恢复之前的 raster scope。

## 已验证

- `test-output/deep2d-dynamic-density-cpu-20260918.log`：38 suites，596 通过/6 显式忽略；包括全 lib、chart 家族、GlyphRasterCache。动态新增 0.75/1.25/1.5/2/3 倍、中文/英文/Hebrew 混排、换行/glyph 数不漂移、逻辑 rect/clip/hit 不变、1x 返回后像素不污染、坏倍率/超预算旧候选保护。
- `test-output/deep2d-dynamic-density-bin-20260918.log`：139 通过/51 显式 GPU 忽略；clippy all-targets/all-features `-D warnings` 通过。
- `test-output/deep2d-dynamic-density-window-recovery-r2-20260918.log`：真实 RTX 4060 Laptop/Vulkan 窗口 1/1，零 surface 时有效密度候选不提交，恢复后 1.5x 提交、再按真实客户区/画布比刷新；旧数据/模拟游标保护和 renderer 重建继续通过。首轮测试误把初始 fixture 的 1x 视作实际 letterbox 比例，实际是 0.84375，第二轮改为从同一映射求期望，没有放宽断言。

首版播放器 SHA-256：`342B06E50BFE45FF288389BAE49E97C70E2E670BB4AC0AD62F7DAC5055BF6ADB`。`test-output/dashboard-text-density-matrix-20260918-r2/` 使用此 exe 完成静态 1x/2x × 有效倍率 1/1.25/1.5/2 × 两轮共 16 个真实窗口，包含动态轴原像素 crop。另两张 `dashboard-text-density-2x-cached-20260918/round-{1,2}.png` 已目视，位置稳定、无新溢出；不将单页检查扩称 V-02 完成。

分数倍率精度补丁：`ceil(logical×scale)` 的分配补齐不能压回原 rect，否则字形仍有不足 1px 的二次采样。现 quad 为 `physical/scale`，以原逻辑 rect 裁去补齐边缘；可见布局、命中和裁剪边界不变。新增断言物理 atlas 到 quad 像素 1:1、可见 rect 与原来逐值相等，3 个 raster 测试和 1 个图表集成测试通过。与图标资源合并构建的 Debug SHA 为 `BD811E7E5994DA2AE124DCE53A16677110E49CE460F4D9E9D15D594E17C9E68A`。

最终产品名称/图标合并底座 SHA 为 `6be390c7c4a3dce57ff09ba03a325a49e245319a82f4547a7b830ef1984e813f`；共用 Native 品牌切片的真实窗口 `test-output/native-client-branding-20260918/default-round-{1,2}.png` 已逐张目视。RTX 4060 Laptop/Vulkan、客户区 1200×800、DPI 120、逻辑画布 960×540（有效倍率 1.25），动态轴/图例及静态标题、KPI、表格两轮位置稳定，无新增裁切或重叠。运行包 SHA 为 `bceab460bd3526c79bccf0929b8753860dada34792a4b030d5814742719f0308`；下载包装后的 EXE SHA 为 `cf618cce51757a6215b1eafe26fcfc3ad5908df37bd1a146d3ade615b22148a1`，完整身份见同目录 `evidence.json`。最终全 targets/features clippy `-D warnings` 再通过。

## 性能边界

本片不混入轴缓存前后性能样本；那一片的已验证 Release、三组成对计时和 20 轮稳定性见 [V-04](deep2d-v04-short-stability-2026-09-18.md)。高倍率 RGBA 的面积增长是实际清晰度成本，保留原有物理栅格和资源预算，不放宽阈值。
