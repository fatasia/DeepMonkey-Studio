# SDK 可运行样例入口验收（2026-09-06）

状态：本入口已验收。r13 同一冻结 bundle 两轮正式浏览器门禁通过，并完成两轮截图亲审；仅覆盖下述 SDK 入口，不代表整个插件生态完成。

## 已实现与已验证部分

新增文档中心第 16 篇指南 `sdk-examples`，提供三个只读 Worker 样例。展示、复制与插入使用同一份源码。每个样例给出执行上下文、可用 API、权限、预期输出及修改建议。

新增通过当前用户/项目/应用与原编辑器路由绑定的一次性请求，复用既有脚本草稿保护和独立文件列表。同名按编号新增，未知 ID 拒绝，取消/Esc 不发送请求，失败不重试插入。文档往返不执行整页重载；三维进入文档前使用现有渲染器恢复快照保留实时场景状态。

新增本身不调用运行、发布或显式保存。自动保存开启时仍由原生命周期保存新文件，文档已明确该行为；关闭时可手动保存。样例默认启用，用户保存和发布后遵循原应用自动生命周期。

聚焦测试：`pnpm --filter @bim-studio/web exec vitest run src/docs/sdkExamples.test.ts src/behavior/sdkExampleInsertion.test.ts src/hooks/useSdkExampleNavigation.test.ts src/components/DocsSdkExamples.test.tsx src/components/DocsCenter.test.tsx src/docs/docsCatalog.test.ts src/hooks/useAppNavigationController.test.ts`，7 文件 38 项通过。门禁脚本 `node --check` 通过。Web 类型检查最近一轮 SDK 文件无错误；并行模型测试的类型错误由主任务统一修复与复验。

## 设计依据与视觉闭环

使用 `design-taste-digitaltwin`：以开发者文档的清楚层级、可修改示例和运行日志反馈为核心，参考 [ThingJS 官方快速入门](https://docs.thingjs.com/cn/App_dev/ThingJS/Content/Quickstart.html) 的示例复制、编辑与运行路径。该引用仅用于内部对标，产品界面未加入竞品标识。

发现文档原 CSS 整页硬编码暗色/金色后，按同族原则将本文档中心的表面、文字、焦点、选中态、代码块与复制反馈统一替换为 `base.css` 既有令牌；补 480px 目录收纳。没有新增品牌令牌，没有更改场景内容色。

十维自评（仅本入口，10 分制）：布局 9、令牌 9、文字 9、交互状态 9、动效 9、三维 N/A、信息层级 9、操作反馈 9、响应式 9、工业语义 9。三维未新增渲染效果；只验证原场景与相机保持。反馈分来自真实操作状态，不作毫秒级性能承诺。对标用于限定设计检查，不声称第三方量化评审。

## r10 失败与诊断记录（不是验收通过）

- `sdk-examples-C3FrBK`：正式模式在暗色选中样例简介对比度 4.260:1 处失败。后续诊断发现亮色同处 3.828:1。根因是 `text-muted` 叠加 `accent-soft`，已统一改为 `text`，待新 bundle 复测。亲审还发现主新增动作在代码块后落到首屏之外，已移到源码前。
- `sdk-examples-YPLBm6`：新文件确已生成，但仍选中旧文件。根因是脚本 Overlay 首次 inline 挂载消费请求后，又因 portalReady 切换到 portal 重挂载，已清请求无法在新面板恢复选择。并行脚本任务将请求延迟到稳定 portal 后消费，并增加失败 `finally` 消费；没有放宽原草稿保护。
- `sdk-examples-f9z4X0`：变量样例正常在 `onStart` / 初始 `onData` 各输出一次，门禁对日志使用严格单元素定位而失败；已改为等待首条匹配日志，不改产品去重语义。
- `sdk-examples-H51u8U` / `sdk-examples-hiq9rH`：显式 `--diagnostic` 模式完成四组功能诊断，报告 `passed:false`。该模式记录低对比并手动选择新增文件，只用于找后续问题；不得替代正式模式。后一轮增加1280双主题三维相机调整→文档→新增→返回→显式保存验证，相机、Primitive 与脚本完整。每组3个真实 Worker 均释放；入口不开启 Worker；自动保存关闭时，显式保存前零业务写。
- `sdk-examples-nwwduz`：三维1280自动保存标签文字被旧CSS隐藏，门禁按可访问名称定位失败；控件本身存在。已向主任务报告同族补 `aria-label`，测试先使用观察到的 `.topbar-auto-save input` 继续验证。

正式结论仅使用无 `--diagnostic` 的新 bundle 两轮结果。

## r11/r12 复测记录（仍待最终冻结轮）

- `sdk-examples-nd6Uy0` / `sdk-examples-KSFerN`：按钮实际金底黑字，旧对比度探针将 Chrome 过渡中的 `oklab()` 通道误当 8-bit RGB，误报 1.001:1。已修公共 `browserTextContrast.mjs` 为离屏 Canvas2D sRGB 解析，保留透明祖先及透明文字合成，阈值仍为 4.5:1。真实 Chrome 测试中 rgb / color(srgb) / oklab 同金色均为 9.716:1；透明文字 4.004 与黑底黑字 1 仍不能通过。未更改产品颜色来迁就测量。
- `sdk-examples-6CO40O` / `sdk-examples-0Ge4AW`：各四组严格功能、对比度及零产品错误通过，12/12 Worker 释放；深浅主题均使用金色。暗色最低 5.530:1、亮色最低 4.559:1，主按钮约 9.716:1。覆盖期间主任务有 r12 bundle 切换，最终权威证据将使用带构建指纹的冻结轮，不据这两次混用构建声明最终验收。
- `sdk-examples-nL3lcF` / `sdk-examples-eKalYd`：偶发 Monaco `Cannot read properties of null (reading 'left')`，功能链仍完成但严格零错误断言失败。后一报告保留完整堆栈，定位 `indentGuides.prepareRender` 的括号连线 `visibleRangeForPosition(...).left` 无 null guard，发生在首次 SDK 插入之前的草稿编辑。并行脚本任务处理共同编辑器根因；未屏蔽异常、降低阈值或以重跑成功抹掉记录。

SDK 门禁现在记录起止 `dist/index.html` SHA-256，构建中途变化直接失败，避免把不同 bundle 的截图拼成一次通过。

## r13 最终冻结两轮

命令：`node apps/web/scripts/gate-sdk-examples.mjs`，未使用诊断模式。

- 第一轮：`test-output/codex-2026-09-05/sdk-examples-zvc9eg/report.json`。
- 第二轮：`test-output/codex-2026-09-05/sdk-examples-si46zM/report.json`。
- 两轮起止构建指纹均为 `9e25c444d5e9cce5a2e774b6f890d12e9d8ef2f5ec18f5c388a1c21051322159`；各 4/4 组通过，暗/亮主题、1280/980 编辑器及 1920/480 文档覆盖，统一金色。
- 产品控制台错误 0；仅暗色1280各有一条已分类 THREE/ANGLE X4122 驱动警告。24 个真实 Worker 全部释放；所有独立浏览器/API 正常关闭。
- 最低文字对比度：暗色 5.530:1、亮色 4.559:1；主动作 hover 最低 9.611:1。阈值保持 4.5:1，无横向文档溢出。
- 原草稿、唯一命名、取消/Esc、双击只插入一次、自动选中新文件、匿名/无编辑器禁止插入、无名草稿阻止离开均通过。三个样例真实运行，事件样例收到真实画布点击目标。
- 每轮仅 10 次预期保存写（1280每主题3次、980每主题2次），关闭自动保存时显式保存前零业务写。自动保存开启后按原设置持久化；3D 往返后原 Primitive、相机及脚本均保留。

亲审第一轮暗色1920、亮色480与三维返回；第二轮亮色1920、暗色480及亮色980场景事件运行图：主要动作可见、窄屏目录收纳、焦点清楚，无新增关键控件遮挡或空白。旧 r10/r11/r12 失败仍保留上文，未以重跑覆盖。

## 明确限制

- 当前仅完成三个可修改只读样例的入口，不代表第三方插件安装/启停/跨项目工作流已完成。
- `contracts` / `scene-sdk` / `server-sdk` 仍是私有协议、调度与 HTTP 包，不是可直接嵌入任意网页的完整 Viewer。
- 作者会话停止时不保证显示最后一条 `onDispose` 日志；生命周期样例只承诺启动日志与资源清理入口，不为示例放宽旧会话迟到日志隔离。
- 没有改账户、配置、数据库/对象存储拓扑、正常场景或自动化任务；没有新依赖、push 或公开发布。
