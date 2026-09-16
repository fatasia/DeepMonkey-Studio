# Dashboard 文字与图片编译

`compileDashboardRasterContent` 将作者文档中的文字、图片和已支持形状编译为 v5 多页 Dashboard 包，供后续正式发布编译消费。输入字体、图片、计算后文字样式均须显式冻结；此切片不开放发布批准。

## 内容与证据

- 文字调用 Native 冻结字体 producer，记录真实字形像素、字体面、行布局、裁剪和 executable SHA-256；中文与组合字符经过实际整形。
- 图片调用现有 Sharp，校验源字节，应用 EXIF 方向和 cover/contain/fill，输出 sRGB straight-alpha 像素；拒绝动画及多页输入。
- 各页保留稳定节点身份、位置、z 序和可见性。输出作者节点与运行节点映射，源语义、编译图和目标包分别计算 hash。
- 资源与像素有预算，返回结果再次校验尺寸、请求身份和像素 hash。异步 producer 接收独立快照，不能修改编译源。

当前未编译页面外观、容器阴影及圆角、数据绑定与运行行为；能力报告保留 degraded/blocked，`publicationReady` 保持 false。KPI、表格、筛选及作者图表内容仍是 C2 后续工作。旧同步编译器及其 golden 保留，文字估算不参与新像素生产。

## 验证与复跑

独立 HEAD 闭包包含 15 个作者合同/既有 lowering 前置文件和 8 个新实现/测试文件，严格 TypeScript 通过。相关 7 个 Vitest 文件共 62 项通过，Node producer 与真实图片测试共 28 项通过。主工作树使用下列版本化入口再次通过 62 项。

```powershell
$env:C2_NATIVE_EXECUTABLE = (Resolve-Path packages/deep-engine-native/target/debug/deep-engine-native.exe).Path
$env:C2_FONT_PATH = 'C:/Windows/Fonts/msyh.ttc'
pnpm exec vitest run --config scripts/dashboard-raster.vitest.config.mjs
node --test scripts/lib/nativeTextRasterizer.test.mjs scripts/lib/dashboardRasterHost.test.mjs
```

未提供两项环境变量时，真实 Native 集成项明确跳过；不能据此算作生产者验证通过。字体样本仅在本机验证，不复制字体进入仓库。

实际 producer 包已通过 Native 校验及真实 GPU painter，读回 PNG 确认两行中文/组合字符与图片显示，GPU validation clean。本地证据位于 `test-output/c2-dashboard-final-compile.*`、`c2-dashboard-gpu/`。这是内容编译验证，不是完整 Dashboard UI 或浏览器 V-02 验收。
