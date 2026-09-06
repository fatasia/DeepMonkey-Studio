# EX-006 作者 DevTools 真实源码调试

状态：已完成（显式作者 DevTools 会话、限定 Chrome 真断点闭环）；项目级后验收与下列未覆盖项仍保留。

## 能力与依据

现有 Worker 生命周期单帧已由 EX-005 完成，本次直接复用。浏览器页面没有自动附加任意 CDP 的产品权限；本次提供明确的“DevTools 调试当前脚本”作者会话，真正的源码断点、逐语句单步、调用栈和变量检查由 Chrome / Edge DevTools 的 Worker 调试器承担。没有内置调试器、伪断点、模拟变量或推断的 debugger 暂停状态。

官方能力已核对：[Chrome Worker 上下文、断点和单步](https://developer.chrome.com/docs/devtools/javascript/reference#threads)、[CDP Debugger](https://chromedevtools.github.io/devtools-protocol/tot/Debugger/)、[CDP Target 附加](https://chromedevtools.github.io/devtools-protocol/tot/Target/)。后两者仅用于隔离验收脚本，不向产品暴露 CDP 端口或新增浏览器扩展。

## 工作流与边界

1. 脚本编辑器“更多工具 → DevTools 调试当前脚本”把最新草稿放入已有私有播放副本，不 upsert、不自动保存。
2. Worker 加载源码后停在“源码就绪，等待开始执行”。这是宿主尚未派发生命周期，不声称已命中断点。加载期间的顶层 JS 照常执行，建议把业务调试入口放在生命周期函数内。
3. 按 F12，Sources → Threads → `bim-studio-author-debug`，按可复制的 `industrial-studio-behavior-*.js/.mjs` 查找源码并设置断点；点击“开始执行”才首次派发 `onStart/onData`。
4. DevTools 提供真实暂停、Step into/over/out、Call Stack 与 Scope；产品仅显示会话状态，不根据 Worker 的耗时假定断点命中。修改草稿后重新调试会建立新 Worker，同一脚本保持稳定源码 URL。
5. 停止、关闭、切换脚本/挂载目标、页面/应用/工作区变化，均走原私有会话归属检查。调试 Worker 直接 terminate，不等待被断点暂停的 `onStop/onDispose`。运行副本及未交付结果被丢弃。

仅作者显式 `hostOptions.authorDebug` 暂停初始化和生命周期 watchdog；普通作者试运行及预览/公开自动生命周期仍保留 2 秒初始化、25 ms 执行预算、权限校验、最大在途调用数与命令数限制。调试中的网络/AI请求本身仍有网关超时；响应已到达后清掉该次请求计时器，允许在其后继续停断点。无限循环在作者调试模式由“停止运行”终止。

断点等待时，已有一帧内的生命周期调用保持有限数量；只要存在在途调用，后续 RAF 不推进调度时间，也不追加事件/数据调用。恢复后继续下一真实帧，不追赶断点等待的墙钟时间；保留同帧 update/fixedUpdate 的既有顺序。被等待期间丢弃的事件不会补发，数据只更新最新快照，避免堆积。这不是精确实时仿真模式。

源码 URL 对 ID 编码，避免空白换行破坏调试身份；JS 包装比作者代码多 3 行，ESM 包装多 1 行，UI 明示，运行错误继续映射回作者行号。未新增 source map，用户仍需按源码偏移设断点；不是 Monaco 行号断点。

## 职责与验证

- `behaviorScriptSource`：稳定身份与源码偏移；Worker 编译、错误定位和 UI 复用。
- `SceneBehaviorHost`：显式作者调试等待策略、调度背压和直接销毁；Manager/PlaybackSession 保留原归属与命令授权链。
- `useAuthorBehaviorRun`：创建当前草稿私有调试会话。
- `AuthorBehaviorDebugNotice`：就绪/错误/运行说明和源码复制；仅使用现有令牌。
- `gate-author-script-debug.mjs`、`authorDebugProtocol.mjs`、`authorDebugFixture.mjs`：原 `isolatedStudioGate` 下的真实 Chrome CDP 断点验证，不触及正常数据库或场景。

聚焦命令：`pnpm --filter @bim-studio/web exec vitest run src/behavior src/controllers/applicationRuntimeController.test.ts src/views/AppBehaviorOverlay.test.tsx src/components/SceneBehaviorPanel.test.ts`。新增调试宿主 8 项、播放会话 2 项覆盖初始化断点、普通预算、显式开始、帧/事件积压、固定更新不饥饿、网关请求结束后断点、停止时迟到消息/队列、源码编码和页面挂载退出。生产 bundle 浏览器命令：`node apps/web/scripts/gate-author-script-debug.mjs`。

## 真缺陷与同族修补

- r10 `author-script-debug-c7iD8y` 在真实鼠标关闭时失败：通用按钮的 28px 最小宽度撑大了透明分隔器，覆盖关闭按钮中心。r11 `author-script-debug-Wr4XWp` 四组均在新增宽度断言失败，未把此前通过的调试核心步骤记为整组通过。
- 根因是公共 `:is()` 中多属性 input 分支提高了整条按钮规则的 specificity；普通局部规则仍被覆盖。`SceneBehaviorLayout.css` 仅对分栏/文件列表手柄的 `min-width` 使用 10px/5px 的明确覆盖，保留 button、焦点和方向键语义；浮动角手柄本来就是 28px，不改。样式跟随面板加载，不依赖先打开预览。新门禁既验证首次未运行时尺寸，也验证关闭按钮中心的实际命中元素，不使用强制点击。
- SDK 联动：Overlay 等稳定 portal 挂载后才消费一次性样例请求，防止首次 inline 消费后 remount 重置选中文件；Panel 用 `try/catch/finally` 反馈并消费失败请求，仍通过 `addScripts` 保留有名草稿、阻止无名草稿。此挂载时序由 SDK 真实浏览器门禁负责，纯逻辑测试不能替代。保存文案改为遵循当前自动保存设置。

## r12 正式验证（2026-09-06 10:33–10:35）

根统一 Web build 后冻结 bundle，Chrome `152.0.7977.76`；两轮 `dist/index.html` SHA-256 均为 `d884029f00f13e7fa21da99a9ea4ac9074b36cb003e32de1766b578e95da86aa`。门禁使用真实 Worker CDP，不以主页面文字代替断点证据。

| 门禁 | 本机证据目录（均在 `test-output/codex-2026-09-05/`） | 结果 |
|---|---|---|
| 作者源码调试第一轮 | `author-script-debug-Tugbgb` | dark/light ×1440/980，4/4，退出0 |
| 作者源码调试第二轮 | `author-script-debug-NrQpGd` | 同构建4/4，退出0 |
| 普通作者运行相邻回归 | `author-script-runtime-qGgmMm` | dark/light ×1440/980，4/4，退出0 |

- 8组实际 `Debugger.setBreakpointByUrl` 命中 `onStart`，等待2.6秒 Worker不被生命周期/初始化预算杀死；`stepInto` 进入 `addTwo`，真实调用栈含 `addTwo → onStart`，`evaluateOnCallFrame` 读到 `initial=40/input=40/result=42`。暗色验证普通JS/3行偏移，亮色验证ESM/1行偏移。
- `onUpdate` 断点再等1.2秒，恢复后仅推进1帧，实测调度时间增加6.8–7.1ms，没有追赶等待时间；帧内调用次序和事件丢弃规则另有宿主聚焦测试。停止、选另一脚本、点击关闭编辑器均在真实断点暂停时直接销毁对应Worker；每组4/4释放，应用0 PUT，服务端原文档完全不变。
- 未附加调试器时仍只显示源码就绪，明确开始后正常输出42；没有假称已命中断点。源码复制和成功反馈、说明的Enter/Esc、首次未运行时10px/5px手柄、真实关闭命中对象、编辑器仍有可编辑高度均断言通过。每组产品控制台错误/警告0。
- 相邻普通运行：鼠标/键盘各推进一帧、25ms无限循环终止、当前/全部启用、禁用拒绝、异常日志、私有跨页及外链拦截、显式保存刷新、真实3D方块变青全部通过。每组运行0 PUT，仅显式保存1 PUT、6/6 Worker释放，原pages/data/scenes不被运行改写；青色像素占29.65%–29.70%。首组3D有1条既有ANGLE X4122精度警告，单列driverWarnings，不冒充零驱动警告。
- 本次局部源码最后聚焦命令（不含controller参数）：`vitest run src/behavior src/views/AppBehaviorOverlay.test.tsx src/components/SceneBehaviorPanel.test.ts`，22文件93项通过；Web `tsc --noEmit`、门禁语法检查、diff空白检查均退出0。根全量数字由统一检查点记录，不混用历史批次。

## 视觉闭环与自评

按 `design-taste-digitaltwin` 采用既有脚本工作台、邻接预览、令牌和克制层级；参考 [ThingJS 快速开发工作流](https://docs.thingjs.com/cn/App_dev/ThingJS/Content/Quickstart.html) 的代码—运行反馈，及 [Unity 外部调试器附加工作流](https://docs.unity3d.com/6000.0/Documentation/Manual/managed-code-debugging.html) 的调试归属心智。Unity此页的managed调试不支持Web，本次并未宣称复刻其实现；实际能力依据仍是上文Chrome官方文档。

亲审两轮各4张源码就绪/断点中的页面截图（两主题、1440/980），另审普通运行暗1440/亮980的真实3D截图。截图证明页面布局，真实断点/变量证据在报告CDP断言中，截图没有伪造DevTools面板。新调试文案抽样最低对比度暗8.219:1、亮8.259:1；980下说明自然换行，文件名可复制/选中，长代码使用编辑器原水平滚动。

| 维度 | 局部自评/10 | 证据与边界 |
|---|---:|---|
| 布局构图 | 9 | 邻接预览不盖代码，透明手柄根因修复后真实点击通过 |
| 令牌一致性 | 9 | 既有surface/text/accent，紫品牌及双主题实测 |
| 排版 | 9 | 12px正文/代码层级，完整文件名可复制，长代码可滚动 |
| 交互状态完备 | 8.5 | 就绪/运行/停止/禁用/焦点实测；调试加载失败及剪贴板拒绝尚未做真实故障注入，不能以普通运行错误门禁替代 |
| 动效质量 | 不适用 | 未新增动效，调试状态直接更新，不增加无动机动画 |
| 3D渲染质量 | 不适用 | 本次不改渲染；相邻真实3D像素仅证明命令未退化 |
| 信息设计 | 9 | 主要状态+可复制身份，低频边界折叠；无模拟变量面板 |
| 反馈即时性 | 8.5 | 复制/开始/停止有明确状态；未量化100ms反馈时延，暂停专项性能不以目测代替数字 |
| 响应式与主题 | 9 | 本轮作者桌面1440/980双主题通过；800/480及独立窗口调试未纳入矩阵 |
| 语义与文案 | 9 | 明示DevTools归属、行偏移和非源码单帧；不推断断点状态 |

低于9的两项保留为本轮UI后续补证，不据限定功能通过声称全套Kimi-95或全站视觉完成。

### r13 相邻 Monaco 真错误修补

SDK门禁 `sdk-examples-eKalYd/report.json` 捕获 `IndentGuidesOverlay.prepareRender → visibleRangeForPosition(...).left` 的真实空值堆栈。核对安装的 Monaco 0.56.0 与[上游实现](https://github.com/microsoft/vscode/blob/main/src/vs/editor/browser/viewParts/indentGuides/indentGuides.ts)，仅关闭 `guides.bracketPairs`，保留普通缩进线、括号字符配色及全部编辑能力，不改第三方源码、不吞console异常。

新专项 `gate-monaco-structure.mjs` 在r12旧bundle的 `monaco-structure-mwET27` 4组仍测到10条括号连线，未稳定再现null错误，不能宣称每次必现。r13 `monaco-structure-c6LOul/qjR2OD` 两轮8/8通过，同index SHA `9e25c444d5e9cce5a2e774b6f890d12e9d8ef2f5ec18f5c388a1c21051322159`：每组20次真实键盘清空/撤销+宽度变化，编辑内容指纹一致，危险括号连线0、缩进线10、括号颜色32，0console错误/警告、0PUT。两轮8张dark/light×1280/980截图亲审，代码层级与编辑区域未退化；配置聚焦2/2通过。此相邻r13证据不冒充上述真断点门禁在r13重新运行。

## 明确排除与项目级后验收

未建设页面内 CDP 调试代理、Monaco 源码断点、远程/多用户附加、source map 或任意浏览器兼容矩阵；未将生命周期单帧包装为源码单步。停用调试后默认恢复正常 watchdog，不持久化调试开关。账号、PostgreSQL/MinIO、.env、原场景、GPT接入暂停及用户暂停的语义治理/专项性能/长文件治理保持原决定；不 push。
