# I-C25 真实Play恢复计时与失败重试

补生产退出Play的分段诊断与用户路径证据，保留已有增量差分和全量恢复语义。

## 现状核查

1. 已检索源码与未跟踪：App持有稳定createPlaySessionRestore实例，useScenePlayMode退出调用该恢复器；scenePersistenceController的incrementalPlay分支跳过模型/图元/测量/标注重建，逐实例状态与廉价setter仍恢复。
2. 已读SceneSnapshot、ScenePlayModeHost/Result、PlaySessionRestoreDeps/Outcome与IncrementalPlayRestorePlan。已有快/全量合同、场景恢复代际校验、引擎替换拒绝及可重试快照，不新增场景/运行包字段。
3. package与既有isolatedStudioGate已含Vitest、Playwright及隔离API/Web服务；无新运行依赖或GPU平台。
4. 实际消费为App→useScenePlayMode→createPlaySessionRestore→同一applyScene。现有性能表仅模拟restore计划及引擎调用段，不是生产用户按钮的实机计时。
5. 已查controller/hook/sceneWorkspaceSave测试：增量失败后本会话降级，失败保持Play快照可重试，后续全量失败不能退出。缺两个生产controller联合失败消费回归与真实用户路径分段计时。
6. 已读C25旧提交cb387b50/52d3c74a、权威清单、I剩余表及T30/N6报告；已接线能力不因旧partial状态重做。

已有（不重建）：增量diff计划、四重建域跳过、动画恢复、暂停驱动、快照深拷贝、失败后全量重试、App按钮入口。

真实缺口：生产恢复capture/plan/apply/verify分段与总等待、只读最近诊断，以及实际用户进入/退出和失败消费证据。

## 实施与验证

仅在退出恢复调用时记录分段；普通render/Play帧不增加采样。诊断最近一条，冻结数据，浏览器Performance Timeline同名旧entry清理；测试注入单调时钟，生产时钟沿用浏览器Performance。捕获/计划/快速应用/代际校验/全量应用错误保留原传播与降级时机，计时不改变恢复裁决。

联合CPU验证调用真实createScenePlayModeController与createPlaySessionRestore：快速恢复失败保持active/快照，重试走全量，全量再失败仍保持active，最终成功恢复playhead并退出；既有快路/场景结构变化路径继续检查。

真实浏览器复用isolatedStudioGate，不新增UI入口；深色1920×1080两轮，读取生产Performance Timeline与实际场景恢复状态。由主线协调GPU/共享服务执行。未执行时不写实际用户路径已通过，也不把计划段的CPU时间当模型加载或GPU收益。

状态：已完成。生产计时、联合失败恢复、后端切换归属修复及实际 DOM 两模式各两轮均通过。

## 已执行

- `playSessionRestoreTiming.ts` 仅恢复调用采样 capture/plan/apply/verify，总等待单独记录；冻结最近 receipt，Performance Timeline 仅替换本刀同名 entry。浏览器 measure 失败不影响恢复结果。
- `playSessionRestoreTiming.test.ts` 联合实际 controller 验证增量应用失败与恢复代际失败两个家族。各自保留 active/原快照，全量再失败仍可重试，最终成功恢复原快照及 2.25s 播放头；三次 apply 接收独立快照。没有普通帧/进入时诊断采样。
- 聚焦三文件 27 测通过，Web `tsc --noEmit`、新脚本语法与 diff 检查通过。
- `gate-play-incremental-restore.mjs` 复用独立 Studio 服务、真实页面按钮与 Performance Timeline。两轮深色1920×1080，正常增量退出及增量失败→全量失败→全量成功，共四条 receipt/轮；模型/图元/测量/相机/物理/动画事实核验。
- 故障注入仅替换浏览器测试抓取的 JS bundle 调用点，明确校验唯一 incremental 及两个 full site，产品源码不加故障开关。故障分支与无注入正常路径分别记证。

设计读题：沿用 Studio 深色工程界面与 `styles/base.css`，按钮/失败重试对标既有 Play 状态语义；本刀不新增视觉令牌。截图与10维评分待实际浏览器执行，不用 CPU 通过代替视觉结论。

## 真实入口阻塞核查

已有（不重建）：后端切换候选、取消代际、用户偏好提交、失败保留 WebGL 与 Play 的 loading guard。检索消费、依赖、类型与生命周期测试后，修复锁限于 `useAppRuntimeEffects.ts` 同代 settled 分支及独立回归；不改 Play guard。

真实缺口：切换 `.then` 更新 requested/active 依赖后，React cleanup 先置 cancelled，后续 `.finally` 因而跳过 loading 清除；下一 effect 已满足 requested===active，提前返回。实机 N04Yki 的初始化 setter 序列 true→false→true，最终 requested/active 均为 webgl，页面无异常且 Play 持续 disabled。修复应在当前代成功或失败结果更新后端依赖前清除 loading，迟到旧代仍不得覆盖新代状态。

已修：同代 switched/unchanged/failed 结果在后端更新前置 switching=false，取消检查与原 finally 保留。真实 hook effect 回归覆盖成功、unchanged、失败降级、旧代迟到结果不得清新代 loading、当前拒绝与卸载迟到拒绝。四文件 32 测通过；浏览器脚本已移除定位时的 loading 诊断注入，等待主线重建 Web 后重跑。

## 最终复验与关闭证据

后端偏好取消竞态已收口：切换 effect 持有唯一 owner；仅当前 owner 清理 loading，旧代迟到结果仍被取消。请求回到实际已激活后端时，基于 author engine 与两 bridge 的实际 active 清理当前 pending；React 后端标签相等但实际 surface 不同仍执行切换。真实 hook 负例覆盖依赖 cleanup、旧结果迟到、偏好恢复取消和标签陈旧。四文件共 34 测通过，统一 contracts→engine→web 构建及 Web 类型通过。App 最终恢复成功清除上次失败提示。

最新真实门使用 App-CBzXG-ZB.js，SHA-256：`117da62d6876e977d609d283931d4d0a43a854bdf1d56879031ef85c5966ca3f`。

- 指定 WebGL：`test-output/runs/2026-09-05/play-incremental-restore-5MBzVJ/report.json`，两轮通过。正常增量 4.9/5.3ms，最终全量重试 12.7/12.0ms。
- 无 renderer 参数、实际偏好恢复：`test-output/runs/2026-09-05/play-incremental-restore-0v2cGM/report.json`，两轮通过。正常增量 5.1/5.3ms，最终全量重试 12.7/11.5ms。runner 以 `C25_GATE_RENDERER=preferences` 显式选择并在 report 标注模式。

每轮为独立 browser context，深色 1920×1080，一个实际可保存设备盒体。Play 中实际 DOM 鼠标滚轮改变相机并改变 canvas 哈希；退出后保存对象/相机/测量/物理/动画逐项恢复。快速失败和全量失败均保持 Play 与重试按钮，第三次全量成功退出并清除旧错误。每轮四条 receipt，Performance Timeline 始终只有本刀最近一条，页面异常为空。上述毫秒数是此 fixture 的实机观察值，未外推大型场景收益。

已目视指定 WebGL 第一轮与偏好启动第二轮最终截图：深色令牌、工具栏和面板没有裁剪，设备及相机还原，成功后无旧失败 toast。沿用 Unity Play→作者快照恢复动线。10维自评（本刀恢复交互）：层级9.5、一致性9.6、间距9.5、中文9.5、可辨性9.5、状态操作9.6、反馈9.6、布局9.5、3D氛围9.3、性能9.6，平均95.2/100；同族检查覆盖正常退出、两级失败、重试成功及两种初始化路径。

首次历史门 aRkN3l 的旧 toast 和偏好取消问题已由上述最新构建证据覆盖，历史失败/诊断输出保留用于根因追溯。
