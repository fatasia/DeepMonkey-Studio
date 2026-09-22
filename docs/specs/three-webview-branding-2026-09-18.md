# Three WebView 发布品牌消费

Three WebView 发布器消费发布包里的名称和图标；空字段使用 Deep Monkey Studio 产品默认，不继承服务器管理页的全局品牌。

## 构建入口

UI 下载的 `.three-webview.bimscene.zip` 内 README 已包含构建指引。沿用既有发布版本与资源来源，只增加品牌归档参数：

```powershell
pnpm --filter @bim-studio/desktop bundle:scene-viewer --publication-file "publication.json" --project-file "project.json" --client-branding-package "client.three-webview.bimscene.zip"
```

归档必须通过全部路径、大小、SHA 校验，且目标是 Three WebView 正式交付、项目/场景/发布时间与构建来源一致。品牌归档不替代发布 JSON 或资源获取。`--product-name`、`--icon-file` 可显式覆盖；PNG/ICO 校验和多分辨率转换复用 API 品牌模块，没有第二套转换器。

名称覆盖 Windows 标题、EXE 产品信息、Web 文档标题和安装程序名称；ICO 同时写入 Tauri bundle 与 NSIS 安装/卸载图标。只读页不再挂编辑器的「桌面工作台」标题栏。真实启动还发现并修复旧 overlay 自动建窗与 Rust setup 手工建窗冲突，`create:false` 统一由 setup 建窗。

## 证据

- Node 发布器相关 13 项、Web 导出相关 12 项通过；覆盖默认、名称/图标独立回退、同发布身份、损坏图标、覆盖优先级和 README 指引。
- 真实只读 Web 生产构建和资产摘要验证通过；Tauri release EXE 与 NSIS 安装包实际构建通过。既有 Draco Node builtin 外部化和大 chunk 提示未消除。
- `test-output/three-webview-branding-20260918/final/`：默认/中文自定义各两轮原生窗口标题、16px 图标、Windows 产品信息与截图；两轮 1920/980 浏览器截图与无 pageerror 证据。浏览器另注入桌面标记，明确断言没有「桌面工作台」框架。
- 自定义最终 EXE SHA-256：`df9c7293d242be35da8a033452c252035a2de221b37ace29694ed67d358bc4b6`；NSIS SHA-256：`e8981c6f01cc5e515954b426facbab7ba3561d5510fe2f162d5983d7c714fc2f`。保留 `final/custom.exe` 与 `final/default.exe`，后者为最终桌面 release 目录的当前内容。
- Three 归档验证不再预加载 Native 编译模块；原 Native 验证在目标判断后惰性加载，取消在新增 await 后重新复核。新增品牌与共享 ZIP 验证合计 34 项通过。

视觉对标为 Unity Player Settings 的发布品牌独立覆盖；页面保持既有数字孪生令牌，没有新增样式。此次不重新评估场景渲染水平：两轮截图用于品牌和窗口检查，旧夹具缩放/机位不代表完整 3D 视觉验收。10 维度中令牌、排版、语义和信息一致性按本次品牌变更检查；动效、3D 效果、全面交互与双主题矩阵未在本片重新验收，不给推测分数。

边界：未执行 NSIS 系统安装/卸载；未增加 Three 归档中全部应用、数据运行时的独立消费器。该完整交付范围不能由品牌接线代替。
