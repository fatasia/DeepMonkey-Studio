# EX-005 作者脚本隔离运行与逐帧

状态：已完成（本批实现与聚焦验证）；项目级后验收仍保留。

## 根因与范围

旧作者运行控制器直接将 Worker 组件命令派发至 ApplicationSession.store、将变量发布至全局数据桥，并让 SceneCommandExecutor 操作作者 Viewer。停止仅销毁 Worker，不恢复上述副作用。旧面板还会在试运行前 upsert 草稿，因此测试与应用编辑混成一次操作。

本批复用已验收的 ApplicationPlaybackSession、SceneBehaviorManager/Host、PlaybackContext、PlaybackView，不建设第二套 Worker 或复制 SDK。作者工作台采用同屏代码/日志 + 邻接可丢弃运行预览；原编辑工作区保留，停止后直接露出原视图。ThingJS 的代码—运行反馈工作流为主，Unity 仅补充挂载与生命周期心智；源码调试不冒充生命周期暂停。

## 已完成

- `authorBehaviorDocument` 只将最新草稿叠入深拷贝：默认当前；全部启用仍按页面/对象就绪加载，项目锁定依赖均保留。禁用、失效挂载、无运行页面明确拒绝。单个三维对象自动建立只存在于运行副本的场景页面，不改变作者路由。
- `useAuthorBehaviorRun` 独占一次运行的状态、Worker、RAF、日志与依赖完成身份；切应用/工作区/关闭销毁，旧运行与迟到响应不得覆盖新会话。运行不 upsert 作者文档，不写全局变量桥、作者 Viewer 或自动保存。
- 复用正式预览的真实 2D/3D 渲染/命令/日志；组件与 Unity 更新落私有状态，场景命令只连接私有 Viewer 端口。页面跳转只变更试运行页，外部跳转显示已拦截；不运行旧式主线程事件脚本。
- 暂停后的单帧固定推进 1/60 秒，复用调度器的 update/fixedUpdate 规则；任何目标尚在初始化或上一调用未完成时禁用，不恢复连续调度。既有 25ms 执行预算、无限循环终止及故障隔离保持有效。
- 停止保留代码草稿/运行诊断；上下文变化清理旧日志；保存仍为单独可见操作。旧 applicationRuntimeController 删除 160 行直接作者运行路径，窗口入口调用私有会话，不再含重复命令路由。
- 新 UI 采用已有令牌/字体，运行范围单行，逐帧命名明确“非源码单步”。邻接预览不遮代码，浮动/独立窗口继续使用既有布局，预览仍位于主工作区。

## 验证

- `pnpm --filter @bim-studio/web exec vitest run src/behavior src/controllers/applicationRuntimeController.test.ts src/views/AppBehaviorOverlay.test.tsx src/components/SceneBehaviorPanel.test.ts`：80 项通过（包含并行语义参数测试）；本包 `tsc --noEmit` 通过。
- `node apps/web/scripts/gate-author-script-runtime.mjs`：最终证据 `test-output/codex-2026-09-05/author-script-runtime-LE9JXj/`，dark/light ×1440/980 四组通过，最低抽样文字对比度暗 6.00、亮 5.00；已人工查看最终亮色窄屏对象预览与暗色宽屏私有跳转截图。
- 真实键盘修改最新代码→当前不跑其他脚本→全部启用→暂停稳定→鼠标/键盘各推进一帧→停止恢复→禁用拒绝→脚本异常/无限循环 25ms→显式保存/刷新；运行期间 0 PUT，只有显式保存 1 PUT，服务器 pages/data 未改变，每组 6/6 Worker 释放，控制台无产品错误。暗色 1440 首次 3D 编译出现一项既有 ANGLE X4122 精度告警，单独记入 driverWarnings，未隐藏或当作零警告。
- 真实点击运行页面按钮仅切私有页，不改作者 URL；外部 URL 跳转显示拦截提示且未新开页面。对象脚本自动创建运行专用 3D 页，真实 Viewer 中方块变为青色，截图青色像素占比 29.65%–29.70%；停止后服务器原场景仍为白色。DOM 成功状态不足以证明视觉命令生效，门禁同时检查实际像素和运行日志。
- 相邻回归：`gate-script-editor.mjs` → `script-editor-aU1HPs/`、`gate-script-playback.mjs` → `script-playback-81tvnw/` 均在最终生产构建通过四组主题/视口验收；包含最新代码、文件栏、保存失败重试、错误定位以及正式预览自动生命周期与页面切换，未以作者隔离门禁替代相邻链路验证。
- 首个夹具错误为多函数键盘输入漏最后 `}`，已按实际 DOM 代码核对修正，不改产品语法校验。原电源样式 checkbox 的 SVG 在输入中心，鼠标应点击可见 label，键盘按 Space；未把 Playwright 对透明 input 的点击等待误报为产品不可用。
- 中间证据 `author-script-runtime-Bfwvrh/` 曾自动通过但人工截图发现白色方块与权限错误：测试夹具遗漏 `studio.data` 能力，`ctx.self.setColor` 所需的既有授权未满足。保留产品授权合同，修正夹具并增加实际青色像素/错误日志断言后重跑为最终 LE9JXj；该中间证据不作为 3D 成功证明。

## 本轮待办

- 真源码断点、调用栈/变量检查、附加调试器与暂停超时协商尚未实现，不能声称达到 Unity 调试器能力。本批只有可信生命周期单帧。
- 全仓作者旧行为状态/ref 的进一步纯清理与其他过载控制器治理由后续结构批次统一处理；保留未使用旧清理端口不等于仍有作者 Worker 写入口。
- 远程网关请求遵守既有权限合同；本批隔离作者文档与视口，并非断网沙盒或回滚远端服务业务副作用。依赖读取可晚到但不会启动已取消会话，尚未把所有 API 请求改为传输级取消。

## 明确排除与项目级后验收

不 push，不改 admin/admin、.env、Postgres/MinIO 或原项目场景；GPT 接入暂停、§28 排除延续。全站 E2E/无障碍/性能/稳定性/发布回滚仍是项目级后验收；局部截图和单元测试不代表全平台已超越 ThingJS/Unity。
