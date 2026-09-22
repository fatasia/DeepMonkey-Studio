# 场景客户端品牌随包传递

场景发布弹窗可配置本次客户端名称和 PNG/ICO 图标；空值恢复 Deep Monkey Studio 默认，不修改系统品牌或场景快照。

## 已完成

- 管理中心、编辑器共用 `ClientPackageBrandingFields`；图标读取期间禁止提交，名称错误、恢复默认、切换仅发布均有实际交互验证。
- 发布前复制并校验品牌输入，保存到原有 artifact 记录；失败重试复用相同发布版本和品牌。品牌摘要进入任务身份，空品牌保持旧任务 key。
- Three WebView / Deep Native `.bimscene.zip` 的 manifest 记录可选 `branding.applicationName/iconPath`；图标作为本地负载进入大小、SHA-256 和完整包身份。预检后改品牌拒绝交付。
- 消费 CLI 校验品牌字段、图标路径、2 MiB 限额、实际 PNG/ICO 类型与完整文件哈希，不拉取外部图标。

## 验证

- Web 定向测试覆盖输入边界、发布前冻结、预检漂移、artifact 恢复/重试、真实 exporter ZIP→CLI。
- Web TypeScript 检查通过。
- `scripts/verify-scene-branding-browser.mjs` 使用实际发布组件和样式，隔离发布回调；不是服务端发布或 EXE 验收。
- `test-output/scene-branding-browser-20260918-r2/result.json`：两轮 × 1920/980/480 × 深浅主题，共 12 组通过。原像素截图已检查桌面深色和窄窗浅色；上传、提交参数、恢复默认、目标切换、Esc、水平溢出和控制台错误均断言。
- 首轮脚本漏挂全局 Esc hook，12 组在最后 Esc 断言失败；修复测试宿主后完整重跑，不计为产品修复。

## 视觉复核

对标西门子工业设置的紧凑层级、FVS 发布设置的信息密度；遵循 `design-taste-digitaltwin`，复用 `styles/base.css` 和共享字段组件，无新增设计令牌。评分依据上述两轮截图与交互：布局 9、令牌 9、排版 9、状态 9、动效 9（未引入新动效）、3D 不适用、信息 9、反馈 9、响应式/主题 9、文案 9。

## Scene 独立 EXE 后续收口

同日后续已接通 Deep Native 正式 EXE：新发布任务记录 `format: executable`，重试仍锁定同一发布版本；旧 Native archive 记录保持原 ZIP 路径。服务端从现有候选发布后冻结的 `nativeCompiled` 读取精确产物，复核报告、对象路径/大小/SHA、发布归属、窗口验证时的 EXE SHA，然后复用共享 overlay 包装。没有新增候选状态机。

`POST /api/projects/:projectId/scenes/:sceneId/publications/:version/native-executable` 仅允许 enabled admin 或项目 editor；viewer、跨项目、坏品牌、任意程序输入拒绝。下载不重编场景或替换已验证的播放器。EXE SHA 漂移要求重新验证并发布；打包结束再次检查原版本未变。

真实验收：`test-output/scene-standalone-executable-20260918/evidence.json`。隔离实际 HTTP 新候选 12 帧 GPU 验证→发布→默认/自定义品牌 EXE 下载→关闭 API→零参数启动各两轮。默认标题 Deep Monkey Studio，自定义标题“热电园区三维客户端”，原 Box 内容一致，内嵌产物 SHA `07ec01ee3b644a373725faf6aa4dfea42b8f9842780763cc4cc81b2913075358`。未依赖旁置 runtime JSON。

四图客户区由独立 sharp 解码检查：1200×800、304 色、134393 非背景像素、蓝色主体占 13.38%，RGBA SHA 全等 `3c81c53ec424581eb4ede7a2b2f4fcef4bbf96c295c862674dd7676640d7c91e`。`pixel-evidence.json` 避免把标题栏或图像预览的相似图显示异常当内容证据。此验收只覆盖冻结 Box 夹具，不扩大为所有 BIM 资产或渲染功能完备。

EXE 新文案与输入两轮浏览器：`test-output/scene-exe-branding-browser-20260918/result.json`，12 组通过。API/Scene候选/冻结资源/共享Dashboard包装 51 项测试通过，Web artifact/action/API 125 项加交付 4 项通过；API TypeScript 通过。

Three WebView 的 Tauri builder 仍从 HTTP publication 构建，不消费运行包自定义图标描述；其自定义图标交付不在本次 Native EXE 成功范围内。该入口未给 `--product-name` 时已统一默认 Deep Monkey Studio，显式名称继续生效，有针对性 Node 测试。安装、升级、卸载和全部原主线渲染字段仍按主线报告分别验收。
