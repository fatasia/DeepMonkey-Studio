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
| 刀 1:视觉三命令(渐变/圆角/阴影) | 已闭环 ef7d46b7 | paint_data.rs 逐式镜像+native_deep2d_v1.wgsl v2+deep2d_paint_gpu_tests 真 GPU 对拍(内部零分歧);rendererCapabilityManifest `deep2d-visual-trio` |
| 刀 2:组件布局引擎(taffy) | 已闭环 c330c3f7 | deep2d/layout/(flex solve→命令产出,零新增变体)+app/deep2d_context 接线+deep2d_layout_gpu_tests(卡片+文本+图标最小样例真 GPU 逐像素)+layout/golden_tests;manifest `deep2d-component-layout` |
| 刀 3:stencil-then-cover 动态路径填充 | 已闭环 2026-10-05 | deep2d/painter_dynamic.rs(滑窗 8 帧≥3 变更自动分路,无用户开关,wire 零变化)+deep2d_dynamic_gpu.rs(clear→cover→fill 三连,Stencil8;nonzero 前向增/背向减,evenodd 双向 Invert 翻 LSB)+paint_reference 同语义 oracle+deep2d_dynamic_gpu_tests(N 帧/fill-rule donut/渐变/scissor/混帧/composite 真 GPU 对拍:内部零分歧,逐像素 worst=0);如实:动态命令 stroke 维持 CPU、边缘 1× 硬边与静态路一致;manifest `deep2d-dynamic-path-fill` |

## 刀位(顺序执行,owner 域互斥)

### 刀 1:视觉三命令(渐变/圆角/阴影)— **已闭环(ef7d46b7)**
- FillLinearGradient/FillRadialGradient(paint 枚举扩展,GPU 逐像素函数,不经图集缓存)
- 圆角矩形(corner_radius,fragment SDF 判内,零 CPU 几何;描边跟随)
- BoxShadow{offset,blur,spread,color,radius}(解析 SDF falloff,零额外 pass)
- CPU 镜像同公式 oracle 对拍;validate_commands fail-closed
- owner:`src/deep2d/`(禁 Cargo.toml/app/)

### 刀 2:组件布局引擎 — **已闭环(c330c3f7)**
- 引入 taffy(flexbox/grid;MIT/Apache 双许可,固定版本+SHA-256,符合开源依赖门槛:逐文件审计、可复现构建、随包交付)
- 布局命令面:`LayoutTree{node: style, children}` → solve → 每个 leaf 产出 quad 几何,喂给 runtime_quad
- 与 deep2d_context 接线;布局结果可被视觉三命令消费(圆角卡片+flex 排布=组件化 UI)
- 测试:布局求解黄金用例(flex row/column/wrap/justify/align)+与 web 侧布局对照样例
- owner:Cargo.toml+`src/deep2d/layout/`(新子目录)+app/deep2d_context.rs

### 刀 3:stencil-then-cover 动态路径填充 + 收尾 — **已闭环(2026-10-05)**
- 实时 GPU 路径填充(stencil-then-cover):动态路径 CPU 归零;静态路径继续走图集缓存路线(保留 CPU 镜像 oracle)——**落地**:fence 竖直挤出 cover pass 写模板 + fill pass 着色;静态/动态 oracle 同语义对拍(内部零分歧,单环逐像素 worst=0)。如实边界:动态命令 stroke 维持 CPU 描边展开;边缘 AA 为 1× 硬边(与既有静态路径管线一致,全管线 AA 缺口另列);动态分路要求命令能完成一次静态冷启动(超大环受静态细分点上限约束)
- 开关:按路径动态性自动分路(每帧变更计数阈值),不设用户开关 —— **落地**:滑窗 8 帧≥3 次内容变更自动分路+资格 gate(有 fill/非解析 quad/无多边形剪刀),预算超限回落静态并计数上报;稳态内容滑出窗口自动退回缓存路线
- 收尾:deep2d 能力清单写入 rendererCapabilityManifest(2D 域行),对标文档回填实测结论 —— **落地**:`deep2d-visual-trio`/`deep2d-component-layout`/`deep2d-dynamic-path-fill` 三行四表登记(contracts TS+金样+native selfCheck+web selfCheck,对拍网 scripts 22 测+contracts 3 测+native 5 测绿);最小组件样例截图留档 test-output/deep2d-layout-sample-20261005.png(web 端无 native 命令通路,按约定以 GPU readback 像素证据留档)
- owner:`src/deep2d/` GPU 管线文件

## 验收口径
- 每刀:cargo test deep2d 全绿+CPU/GPU 对拍容差不放宽+体量门 800 行/文件
- 线级:GPUI 对位表三件全消;组件布局可跑通"卡片+文本+图标"最小组件样例(截图留档)
- 文档/wiki 在全线完成后统一补(用户指令)
