# G2-S2b/S2d Play 草稿/重新应用状态与轨迹回放 UI(G 系列收口行,2026-10-02)

- 线路:估时表 G 行 G2-S2b/S2d(6–12h 档);承接 S2a(`g2-s2a-visual-review-20261002.md`),同真值文档 `g2-behavior-authoring-design-20260930.md`(§2.3 热重载 / §2.4 确定性回放 / §3-6 达标线)
- 结论先行:**S2b 与 S2d 的真实缺口全部闭环**;12 文件 126 测全绿 + Web tsc/build 0 错;真实浏览器两轮 1920×1080 深色截图 12 张逐张人工复核通过;顺带修复 **1 处被本线路暴露的既有产品层缺陷**(视口状态条被作者画布 z1 永久遮蔽,同族 4 处一并修复);G 行(S2b/S2d)可整行关闭
- 诚实声明:本轮所有 UI 证据均为 WebGL 渲染器、`OBJECT_STORE=local` 隔离环境实测;未 commit(遵守线路纪律)

---

## 一、现状核查(六步,详证 `g2-s2b-s2d-play-replay-progress/progress-01-survey.json`)

1. **grep**:全仓无 `playDraft` 符号——"Play 草稿"是估时表 G 行对剩余缺口的措辞;Play 域(`useScenePlayMode`/`playSessionRestore`/`restrictedPlayConsumer`)与 T31(`behaviorTraceLog`)文件清单固定。
2. **契约**:`BehaviorTraceEntry`(seq/atMs/graphId/eventNodeId/action/actionNodeId/target/before/after/outcome/reason,环形 ≤4096,注入时钟)即回放真值;`SceneDirectorWorkspace` 三工作区。
3. **依赖**:零新增;导出沿 PhysicsDebugPanel 的 Blob+anchor 先例。
4. **消费方**:`restrictedPlayConsumer.onTrace/onCommand` 接口存在但 **App 创建时未传——T31 轨迹在生产 Play 链路被丢弃**;引擎 `snapshotModelAnimationEventTrace()` 公开但 **零 UI 消费方**(dead API)。
5. **测试**:T30 生命周期/恢复/历史隔离 34 测、I-C25 双失败重试、T31 日志与运行时确定性测试全在且绿——**复用不重建**。
6. **规格**:I-C25 已收口"退出/异常后重新应用状态"的全部机制(分段计时/双失败重试/加载竞态)。

**已有(不重建)**:Play 快照恢复全链、Play UI 半壁呈现(按钮 is-playing 态/自动保存暂停徽标/undo-redo 禁用/进出 toast)、T31 全链、SceneTimelinePanel 导演台(549 行)、S2a 验收基建(isolatedStudioGate)。

**真实缺口**:S2b——①未保存脚本草稿不参与 Play 但进入时零呈现;②Play 期间临时修改无计数、退出无丢弃汇报。S2d——③Play 会话 T31 轨迹生产链路被丢弃,退出即失;④确定性回放面板(时间轴 scrub/步进/before-after/outcome/JSON 导出)为零。

## 二、S2b 闭环(Play 草稿语义 + 丢弃汇报)

| 项 | 实现 |
|---|---|
| 草稿排除呈现 | `formatPlayEntryNotice(hasPendingBehaviorDraft)`(useScenePlayMode.ts 纯函数):有未保存脚本草稿时进入消息附加"未保存的脚本草稿未参与本次播放,按已保存版本运行"(热重载语义 §2.3 的如实呈现) |
| 丢弃汇报 | `useSceneHistoryState` 新增 `playAbsorbedEditsRef`:Play 门禁吸收的每次记账(防抖散记 + 离散命令)计数,记账裁决零改动;App enterPlay 清零、exit 读数,`formatPlayExitNotice(n)` 汇报"N 项临时状态变更已丢弃" |
| 措辞纪律 | 实测被动 Play 会话也会被物理模拟改写模型累计 8 次记账——措辞用「状态变更」而非「修改」,不暗示全部出自用户之手(门禁两轮实测数字 8/12 记入 report) |
| 重新应用状态 | 复用 I-C25 全链(快照深拷贝→applyScene 整体恢复→restore-failed 保持会话可重试→engine-lost 上报),本轮零改动、由既有 34 测守护 |

## 三、S2d 闭环(确定性回放审阅器)

| 件 | 文件 | 说明 |
|---|---|---|
| 轨迹仓 | `scripting/playTraceStore.ts`(新,147 行) | 按 scriptId 收纳 onTrace 全量快照;确定性展开(atMs→graphId→seq);尾沿节流订阅(≤4 次/秒);`bim-studio/behavior-trace/v1` 确定性 JSON 导出(键字典序、体内容零墙钟,T17/T28 纪律) |
| 审阅器 | `components/BehaviorTraceReplay.tsx`(新,325 行) | **只读审阅器,不是第二运行时(§2.4)**:时间域 scrub(全零时间域退化顺序域)、outcome 三色菱形标记(成功/跳过/拒绝)、步进四键+跟随最新、before/after mono 详情卡+裁决徽标+理由、>160 标记/轨道按 1/N 抽稀(数据完整仅省 DOM)、轨迹 JSON 导出;同时消费引擎动画事件轨迹(死 API 首获消费方) |
| 挂载 | `SceneTimelinePanel.tsx` | 导演台第四工作区「行为轨迹」(trace),复用面板壳与页签体系,**未建第二套时间轴**;C4 录制/动画时间线/仿真轨道各归其位 |
| 接线 | `App.tsx` | enterPlay `resetPlayTrace`(会话隔离) + `onTrace→recordPlayTrace`;**退出后轨迹保留可审阅**(审计器语义,重演=重开 Play 会话) |

## 四、顺带修复的产品缺陷(同族清剿)

**视口状态条(`.viewport-status`)与三条视口工具条被作者画布永久遮蔽**。门禁取证链:`elementFromPoint(pill 中心)=CANVAS` → 画布内联 `z-index:1`(`prepareAuthorInputCanvas`)→ pill/工具条 z-auto 被盖。修复:`.viewport-status`/`.measure-mode-bar`/`.annotation-placement-bar`/`.clipping-bar` 统一 `z-index: 2`(作者画布 z1 之上、面板带 12 之下,各带 z-index-audit 注释)。修复前 pill 在任何 studio 截图中均不可见(像素采样实证),修复后进出/退出消息清晰可读。`.tool-dock` 实测可见,不动。

另修导演台 trace 分支行序(`grid-template-rows: auto auto minmax(0,1fr)`,与 camera 分支同族对齐,页签不再被 1fr 拉伸悬空)。

## 五、验证

| 门 | 结果 |
|---|---|
| 聚焦+回归测试 | **12 文件 126 测全绿**(useScenePlayMode 18/sceneWorkspaceSave 17/playSessionRestoreTiming 5/playTraceStore 6/BehaviorTraceReplay 4 SSR/behaviorTraceLog 9/behaviorGraphRuntime 14/restrictedPlayConsumer 10/Topbar 6/InteractionEditor 9/lifecycle 18/sceneSync 10) |
| Web tsc + 构建 | `tsc --noEmit` 0 错;`vite build`+bundle budget 通过(首屏 gzip 96.6 KiB/预算 527.3) |
| 视觉门禁 | `g2-s2b-s2d-visual-gate.mjs` **两轮独立项目/场景/端口全过**(9 步×2;round2 一次通过复证 round1) |
| 证据 | `test-output/g2-s2b-s2d-visual-20261002/round{1,2}/`:各 6 张截图 + report.json(passed=true)+ exported-trace.json(实测下载,format/entryCount 断言过)。round1 的 `failure.png`/`_b*_crop*.png` 为断点恢复期与像素取证遗留,保留作根因追溯,非终版产物 |
| 保护文件 | `behaviorGraphDraft.ts` 全程只读未动;`deliverables/`、`release-assets-v0.1.0/`、`release-staging-v0.1.0/` 未动;无 cargo;`git diff --check` 无空白错误(仅既有 CRLF 警告) |

**截图清单(12 张全部逐张 Read 人工复核,两轮一致)**:t0 空态(页签贴合/摘要 0 态/导出禁用)、b1 进入消息 pill"已进入播放模式;修改仅在本次播放期间生效"+退出播放 warning 态+自动保存暂停、t1 轨迹 6 条(绿菱形 applied 标记/标尺/accent 播放头/详情卡已执行徽标+before/after)、t2 步进+scrub 后 2/6~3/7(选择高亮/详情随动/跟随最新解除)、t3 退出后面板保留完整轨迹+退出消息 pill"8 项临时状态变更已丢弃"、b2 放置立方体后退出消息 pill"12 项临时状态变更已丢弃"+立方体消失(恢复实证)。检查项:溢出/遮挡/截断/对比度/错误可见性,零问题。

## 六、10 维自评(逐维 ≥9 方可交付,依据实测)

| # | 维度 | 分 | 依据 |
|---|---|---|---|
| 1 | Design Read / 现状核查 | 9.5 | 六步核查落盘 progress-01;dead API(onTrace/snapshotModelAnimationEventTrace)以消费方证据定位缺口;I-C25 复用零重建 |
| 2 | 主题与令牌合规 | 9.5 | 两轮 assertDark 锁定;新 CSS 全部引用既有令牌,零新色;z 变更带 z-index-audit 注释并按分层纪律落位 |
| 3 | 布局与信息密度 | 9 | 摘要条/轨道/详情/transport 四层分明,页签贴合标题(行序缺陷修后复拍);扣 1:详情栏 236px 固定宽为最小实现,超长 before/after 依赖换行 |
| 4 | 遮挡控制 | 9.5 | 修复了画布 z1 遮蔽状态条的产品缺陷(像素+elementFromPoint 双实证);pill 与导演台并存可见;抽稀保证 4k 条不爆 DOM |
| 5 | 对比度可读性 | 9 | 深底浅字 12 张全部清晰;outcome 三色(成功/金/红)语义可辨;9px 小字号为产品既有密度体系 |
| 6 | 错误反馈可见性 | 9.5 | rejected/skipped 徽标+理由、丢弃计数、空态引导三重反馈实测可见;SSR 断言锁死文案 |
| 7 | 交互闭环真实性 | 9.5 | 真实用户路径:调色板点击建图+真实鼠标连线+保存门禁+真实 Play 按钮+画布放置立方体+真实下载导出;scrub/步进真实指针 |
| 8 | 两轮独立与可复现 | 9.5 | 独立项目/场景/端口;round2 一次通过且步骤指纹与 round1 全等 |
| 9 | 证据链 | 9 | 12 张逐张复核+双轮 report passed=true+126 测+tsc/build+导出文件断言;扣 1:pill 截图依赖 settle(双 rAF)对抗合成帧滞后,未做逐像素断言 |
| 10 | 诚实条款 | 9.5 | 计数语义(含模拟改写)如实改措辞并记录实测数字;失败轮/诊断遗留物保留并注明;门禁迭代 7 处全数落档 |

**结论:10/10 维 ≥9,通过。**

## 七、剩余缺口(诚实声明)

1. **1 万条浏览的真机卡顿未单独取证(§3-6 后半)**:环形缓冲上限 4096,抽稀后单轨道 ≤161 DOM 标记,理论无卡顿,但本门禁会话最多 ~7 条,未做 4096 条满载实测。留后续压测小项。
2. 根动作/动画事件轨迹(`snapshotModelAnimationEventTrace`)已接入面板(非空时独立来源),但默认关闭,门禁未覆盖其非空路径;其环形溢出时详情卡显示"已被溢出丢弃"旁注,SSR 未覆盖该态。
3. 未保存脚本草稿排除呈现为防御性呈现:现有导航守卫使"带未保存草稿进入 Play"在纯 UI 路径不可达(脚本工作台打开时 Play 被禁用),门禁未构造该态;消息分支由单元测试覆盖。
4. 门禁迭代发现的基建层事实(仅记录):调色板点击放置会落在 `onlyRenderVisibleElements` 视口外不渲染;坞开关重开导演台固定落 timeline 工作区。产品是否调整属后续产品决策,本线未动。
5. 既有声明维持:I-C25 报告中毫秒数为 fixture 实测不外推;工作区中其他会话的未提交改动与本线共存,未触碰。
