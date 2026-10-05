# deep2D 线:GPUI/gpui-fast/Zed 对齐全量任务书(2026-10-05)

> 用户拍板:deep2D 线全做,一次性做好。内置字体、许可、emoji 不考虑;**组件布局也要做**。
> 对标口径:GPUI(Zed 的 UI 框架)/ gpui-fast(性能分析文章)/ Zed。

## 已闭环(不重建)

| 项 | 状态 | 证据 |
|---|---|---|
| 文本整形 cosmic-text 0.19+swash | 与 Zed 同源 | Cargo.toml `=0.19.0` |
| text_document 七件套+text_edit+IME 全家 | 不弱于 GPUI 默认 | platform_text/ |
| 命令面 Path/Text/Image+runtime_quad 合批 | 同水位 | deep2d/command_types.rs |
| painter_cache 五件套+atlas+gpu_cache | 同水位 | deep2d/painter_cache* |
| 描边/虚线/裁剪(CPU+GPU 双路) | 同水位 | painter_stroke/dash/clip+path_clip_gpu_tests |
| raster_reference CPU 权威镜像+oracle | 我们更强 | gpui-fast 文章分析已验证 |
| gpui-fast 借鉴项 1:debug-full-render | 已入库 | rendererCapabilityManifest:202(TAA/TSR reset) |
| gpui-fast 借鉴项 2:帧指纹全量比对 | 已入库 a0570f3f | pbrFrameFingerprintDiff.ts(5 测绿) |
| 帧时性能 | 引擎层超同构水位 | gpui-fast 问询结论 |

## 刀位(顺序执行,owner 域互斥)

### 刀 1:视觉三命令(渐变/圆角/阴影)— **在跑**
- FillLinearGradient/FillRadialGradient(paint 枚举扩展,GPU 逐像素函数,不经图集缓存)
- 圆角矩形(corner_radius,fragment SDF 判内,零 CPU 几何;描边跟随)
- BoxShadow{offset,blur,spread,color,radius}(解析 SDF falloff,零额外 pass)
- CPU 镜像同公式 oracle 对拍;validate_commands fail-closed
- owner:`src/deep2d/`(禁 Cargo.toml/app/)

### 刀 2:组件布局引擎 — 排刀 1 后
- 引入 taffy(flexbox/grid;MIT/Apache 双许可,固定版本+SHA-256,符合开源依赖门槛:逐文件审计、可复现构建、随包交付)
- 布局命令面:`LayoutTree{node: style, children}` → solve → 每个 leaf 产出 quad 几何,喂给 runtime_quad
- 与 deep2d_context 接线;布局结果可被视觉三命令消费(圆角卡片+flex 排布=组件化 UI)
- 测试:布局求解黄金用例(flex row/column/wrap/justify/align)+与 web 侧布局对照样例
- owner:Cargo.toml+`src/deep2d/layout/`(新子目录)+app/deep2d_context.rs

### 刀 3:stencil-then-cover 动态路径填充 + 收尾 — 排刀 2 后
- 实时 GPU 路径填充(stencil-then-cover):动态路径 CPU 归零;静态路径继续走图集缓存路线(保留 CPU 镜像 oracle)
- 开关:按路径动态性自动分路(每帧变更计数阈值),不设用户开关
- 收尾:deep2d 能力清单写入 rendererCapabilityManifest(2D 域行),对标文档回填实测结论
- owner:`src/deep2d/` GPU 管线文件

## 验收口径
- 每刀:cargo test deep2d 全绿+CPU/GPU 对拍容差不放宽+体量门 800 行/文件
- 线级:GPUI 对位表三件全消;组件布局可跑通"卡片+文本+图标"最小组件样例(截图留档)
- 文档/wiki 在全线完成后统一补(用户指令)
