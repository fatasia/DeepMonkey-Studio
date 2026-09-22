# 客户端发布名称与图标

发布者可以为当前客户端指定应用名称和 LOGO/图标。未指定的字段沿用 Deep Monkey Studio 默认品牌。

## 范围

- 名称用于客户端窗口和 Windows 产品信息；下载名称使用可安全保存的名称。
- 图标用于窗口左上角、任务栏和 EXE 文件。PNG 自动生成 16/24/32/48/64/256 像素 ICO；已有 ICO 经校验后使用。
- 设置属于当前交付包，不修改 Studio 全局品牌，不改变已验证的场景或 Dashboard 运行包内容。
- 自定义资源在追加运行包或签名前写入 EXE 的私有副本；部署的播放器原文件及其校验值保持不变。

交互参考 [Unity Player 设置中的 Product Name 与 Default Icon](https://docs.unity.cn/6000.1/Documentation/Manual/class-PlayerSettings.html)。本项不包含新增启动广告或启动动画。

## 当前实现

Dashboard EXE/ZIP 下载支持同一下载入口的 POST 请求，JSON 为 `{ "branding": { "applicationName": "园区运行中心", "iconDataUrl": "data:image/png;base64,..." } }`。默认下载保留 GET。

名称去首尾空白后最多 80 字符，拒绝控制字符。PNG/ICO 输入最多 2 MiB；解码、图像尺寸和 ICO 图片范围均有检查。请求沿用候选权限、有效期与发布能力复核。

Native 通过嵌入的 Windows 资源读取名称与图标；资源写入使用 Windows 打包宿主已有系统接口。非 Windows 宿主不能生成自定义 Windows 品牌 EXE。

## 验证状态

服务端品牌解析、默认真实 ICO、PNG 多尺寸转换、无效输入、取消、下载权限与原 EXE/ZIP 行为已通过聚焦测试，API 类型检查通过。

- Dashboard 发布 UI：两轮 × 1920/980/480 × 深浅主题共 12 格通过。覆盖默认 GET、自定义 EXE/ZIP POST、恢复默认、Web/DMDA 保持原下载。证据：`test-output/dashboard-branding-browser-20260918/result.json`。该浏览器检查拦截候选接口，不代替服务端及 PE 验证。
- Windows PE：中文名称、带引号与 `&` 的名称可读入 ProductName/FileDescription；版本保留，6 档图标与名称资源逐字节回读通过，源 EXE SHA 不变。图标/名称资源统一为中性语言，覆盖前移除同 ID 的旧语言版本，避免 Windows 继续选择旧资源。

- 实际 Dashboard 单文件 EXE：默认/中文自定义各两轮无参数启动，标题栏及 Dashboard 内容可见；读取窗口/任务栏图标，验证 overlay 运行包 hash、ZIP 内品牌后 EXE hash、原候选 hash。证据：`test-output/native-client-branding-20260918/evidence.json`。主线复核已查看默认第 1 轮与自定义第 2 轮完整画面；早期尚未绘制内容的截图不计验收。此项为实际包装函数与窗口验证，HTTP 接线由路由测试覆盖。

三维 Scene 独立 EXE 已接入同一品牌包装器：既有候选验证后发布，下载入口读取该发布版本的冻结产物，复核身份和原播放器 SHA，再追加品牌与运行包。实际 HTTP 默认/自定义下载、停止 API、无参数各两轮启动已通过，证据 `test-output/scene-standalone-executable-20260918/evidence.json`。四张原始截图的 1200×800 客户区 RGBA SHA-256 均为 `3c81c53ec424581eb4ede7a2b2f4fcef4bbf96c295c862674dd7676640d7c91e`；主线独立解码复核一致。此场景为 Box 交付夹具，验证打包与品牌，不代替全部工业场景画质验收。

图标被服务端拒绝时，候选保持可下载，字段可编辑，改图后直接重试。双主题两轮实际浏览器错误恢复 4/4 通过；同时覆盖认证客户端抛出错误与返回非成功 Response 两种路径。证据：`test-output/dashboard-branding-rejection-browser-20260918/`。
