# 页面背景图资源冻结

发布资源清单支持页面拥有的图片，解决背景图不能进入冻结资源集的问题。此片只完成资源绑定，原生背景绘制仍待接入。

- 图像请求可携带 `pageIds`；既有仅组件资源不新增该字段，旧清单结构保持。
- 页面背景URL必须匹配本项目已登记图片，不抓取外部URL；沿用对象路径、版本和内容摘要检查。
- 多页背景与组件共用同一图片时只冻结一次，同时记录页面和组件归属。
- 页面归属进入清单哈希，并在提交前传回生产资源解析器复核；未知页面、无消费者、页面拥有字体均拒绝。

验证：冻结、生产资源闭包、候选运行与离线归档4文件51项测试通过；API类型检查通过。新增用例覆盖页面独占、多页共用、组件共用、归属被修改、移除背景、跨项目和外部URL。

复跑：`pnpm --filter @bim-studio/api exec vitest run src/dashboardPublicationFreeze.test.ts src/dashboardPublishedClosure.test.ts src/dashboardNativeCandidateRuntime.test.ts src/dashboardOfflineArchive.test.ts`。

下一步：将冻结页面图片接入光栅输入、cover/contain/stretch/original与位置/重复规则、系统背景层窗口证据和双端视觉验收。当前背景字段仍deferred，不将资源冻结等同渲染完成。

## 编译输入接线

正式 `dashboardFrozenRasterInput` 已从清单 `pageIds` 导出 `pageAssets`，只接受页面原URL与冻结对象路径完全一致的图片；部署配置不能覆盖。重复、未知页面、错误URL与字体绑定拒绝。多页共用同一份asset；node-only输入不增加字段。

光栅输入检查页面存在、资源存在且为图片；页面归属进入sourceSemanticHash和compileGraphHash。绘制层暂未消费该字段，背景仍deferred，不能据此声称已绘制。

3项脚本测试与2文件19项光栅/资源验证测试通过，Web类型检查通过。命令：`node --test scripts/lib/dashboardFrozenPageAssets.test.mjs`；`pnpm exec vitest run --config scripts/dashboard-raster.vitest.config.mjs apps/web/src/delivery/compileDashboardRasterContent.test.ts apps/web/src/delivery/dashboardDataRasterValidation.test.ts`。

工程十维自评均9，依据窄合同扩展、无新增依赖、内容去重、失败路径与原链路回归。本片未改视觉输出，无视觉完成声明。

## 原生包背景合成

新增独立 `decodePageBackground` 宿主端口，避免旧图片宿主忽略位置/平铺规则后默默输出居中cover。未提供该端口、未冻结图片或背景色不可解析时仍保持deferred。

编译器将背景RGBA放在既有系统背景的颜色路径上方、全部作者节点下方；页面证据单列，不计为作者组件或字体。解码前检查整页与累计图集预算，生产器失败拒绝整个候选。编译配方升为v5，页面图片证据进入编译哈希。

编排测试覆盖层级、规则传递、有效RuntimePackage、独立页面证据、旧宿主deferred、解码前预算拒绝与生产器异常；2文件20项通过。首轮夹具尺寸小于应用合同最小320而失败，修正为合法尺寸后通过。

本片图片生产器仍由测试桩提供，真实像素、系统窗口图集身份与视觉两轮尚未验证；不计背景图正式交付完成。设计沿用FVS画布背景规则与作者端 `dashboardCanvasStyle.ts`，未新增视觉令牌；视觉十维暂不评分。

## 系统图集呈现证据补验

后续验证已使用真实sharp背景生产器及正式compiler/deployment构建，不再只依赖上节编排桩。页面证据绑定冻结图片SHA、原页面URL、页面归属、编译RGBA摘要和Native命名空间图集身份；缺失整个背景draw、缺图集、重复证据、改像素/来源/页面均拒绝。系统层不增加作者节点或字体完成数。

- 窗口证据27项、API能力/候选26项通过，API typecheck通过；移除编译图集并同时清空draw图集的替换也被拒绝。
- 正式compiler集成7项全部通过、无跳过，包括真实中文字体与背景窗口。背景为320×320、original+repeat；1张图集409600bytes、1个image quad，RTX4060 Laptop/Vulkan连续3帧，GPU scopes/callbacks clean。
- Native沿用静态CRT r2 Release，SHA `a729bdee2f8f9782af5302098a17301f691c72844b2284450eef5b0d13032e45`。复跑先构建compiler，再设置 `C2_NATIVE_EXECUTABLE`、`C2_FONT_PATH=C:/Windows/Fonts/msyh.ttc`、`C2_VERIFY_WINDOW=1`，执行 `node --test scripts/dashboard-content-compiler.test.mjs`。
- 首轮新增证据夹具误把Buffer的JSON摘要当作像素字节摘要而拒绝；改为实际字节SHA后通过，验证规则未放宽。

此验证证明真实图片生产与Native提交，不证明全部定位/平铺的跨端视觉一致性；视觉对照由背景producer切片另行验收，HTTP发布背景图也仍待补验。

上述7项集成在producer提交 `ddcadf0` 后重新构建并复跑通过。该producer的缩放/定位/奇数平铺像素与浏览器对照详见[独立报告](dashboard-page-background-producer-2026-09-17.md)，不替代完整页面的跨宿主验收。
