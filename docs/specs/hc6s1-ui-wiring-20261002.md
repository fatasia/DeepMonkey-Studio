# H-C6-S1 编辑器接线:运行中热插应用 UI(2026-10-02,行内续作)

> 承接 `h-c6-s1-hot-swap-20261002.md`(热插核心 `SceneBehaviorHost.updateModule` 已 4/4 测试)。
> 本刀补齐编辑器入口:运行中/暂停"热插应用"按钮 + 成功/回滚/失败三态反馈 + authorDebug fail-closed 禁用语义。
> 里程碑存档:`test-output/hc6s1-ui-20261002/progress-01..04.json`。

## 现状核查(progress-01)

- `updateModule` 全仓零消费方(grep 仅 Host+hotSwap 测试)——UI→会话→管理器链路为真实缺口。
- 既有入口(不重建):`SceneBehaviorPanel`(懒加载,AppBehaviorOverlay 门控)→ `BehaviorPanelHeader` 运行操作(试运行/暂停/步进/停止);运行时条目 `useAuthorBehaviorRun.session.entries` 流入面板。
- Play 草稿门禁交互(G2-S2b):App 级 Play 与行为面板互斥(`playMode.enter` 拒绝于 `sceneBehaviorOpen`);作者试运行会话命令只写会话私有状态/私有视口,不写场景文档与撤销栈 → **热插零 `playAbsorbedEditsRef` 记账**;热插永不静默生效,仅显式点击才把草稿(含未保存修改)换入运行中会话。

## 接线链路

```
BehaviorPanelHeader(热插应用按钮, RefreshCw, pending 时 spin)
  → SceneBehaviorPanel.hotSwapApply(状态机 idle/pending/applied/rolled-back/failed)
    → props.onHotSwap = useAuthorBehaviorRun.hotSwap
      → ApplicationPlaybackSession.hotSwapScript
        (变体 id `${script.id}:hot{n}` 每会话递增,满足核心"同 id 拒绝";
         继承运行中模块已解析依赖)
        → SceneBehaviorManager.hotSwap(挂载键直通 host.updateModule)
          → SceneBehaviorHost.updateModule(旧 onStop → 新 initialize → 恢复形态;
            失败自动回滚;authorDebug/非运行态/同 id 同步拒绝)
```

关键设计:挂载键(entryId)与存档模块保持原脚本身份不变 → 面板 runtime 查找、日志 moduleId 映射、reconcile 存活比较全部稳定,热插变体跨 re-reconcile 存活;命令授权仍按文档已保存脚本的权限(变体不可热插提权,fail-closed)。

## 三态反馈(沿 base.css 令牌,双语 tr())

| 态 | 触发 | footer em[role=status] | 色 |
|---|---|---|---|
| 进行中 | 点击后 | 正在热插应用… | warning |
| 成功 | moduleId ≠ 点击时起点 且为本脚本 `:hot` 变体 | 热插成功:行为已替换为新版本,场景状态与数据流保留 | `--success` |
| 回滚 | lastError 带 Host 标记"热插失败已回滚" | 热插失败,已回滚原脚本继续运行:<原因> | `--warning` |
| 失败 | 诊断 error(回滚也失败) | 热插失败且回滚失败,运行已停止:<原因> | `--danger` |
| 同步拒绝 | host 同步 throw(非运行态等) | 热插应用失败:<原因> | `--danger` |

结算模型在 `behavior/behaviorHotSwap.ts`(纯函数,可脱离 React 单测):回滚标记先于变体判定(二次热插失败回滚的"旧模块"本身就是上一代变体);`fromModuleId` 锚定点击起点防止连续热插误读旧状态;pending 期间面板 props 落后于 Host 同步诊断(rAF 节拍),未传播不结算。

authorDebug:按钮可见但禁用,title 如实给出原因——"作者调试会话不支持运行中热插(fail-closed):调试运行的是脚本私有副本,请停止调试后用试运行重试"。其余禁用态(未试运行/初始化中/已结束)同样给原因 tooltip。

## 验收(实测)

- 聚焦测试 `behaviorHotSwap.test.ts`(9 用例)+ manager 直通(回滚全链)+ 会话变体派生(hot1→hot2、未运行/已结束拒绝)+ 面板渲染(运行中可用/禁用原因/authorDebug fail-closed/无通道回退)= **39/39**。
- 行为域+脚本域回归 **185/185**;面板族组件回归 67/67(修 settle 签名后复跑 207/207);apps/web `tsc --noEmit` exit 0。
- 真实浏览器两轮 + 暂停态附加腿(1920×1080 深色,真实 Chromium,admin 登录,新建验收场景):
  - 成功:footer 绿色成功反馈;日志序列 A1 tick0/tick1 → **A2 started → A2 tick 1(调度时钟延续,场景状态保留)**;worker 遥测仅新增 `:hot1` initialize。截图 `hc6s1-hotswap-success-1920x1080-dark.png`。
  - 失败注入(顶层 throw):footer 黄色回滚反馈含注入原因;日志出现 B1 重放 started 且 tick 延续;日志面板 1 个错误标记;initialize 序列 `:hot2`→8ms→`:hot1`(自动回滚)。截图 `hc6s1-hotswap-rollback-1920x1080-dark.png`。
  - 暂停态:换入后保持 paused(不发 onStart),恢复运行后 C2 tick 生效。
- 浏览器闭环抓出并修复一个真实状态机缺陷:**连续热插误报成功**(详见 progress-04),补回归用例。

## 如实边界

- 同 id 更新(保存后的脚本内容同步)仍走整体试运行(stop/start)——核心合同如此,热插只服务"运行中换逻辑"。
- 变体 id(`:hot{n}`)仅存在于 worker 侧;面板/日志仍按原脚本 id 归档。诊断 moduleId 显示变体 id(证据可见)。
- 页面切换/会话重启后热插状态回归文档已保存版本(reconcile 语义,未做跨会话持久)。
- 驱动程序拦截 monaco 依赖块走降级 textarea 编辑器(规避自动化焦点竞态);被测对象是热插接线,不是编辑器组件。截图中的"代码智能服务加载失败"横幅为该降级路径,非产品缺陷。
- 观察到(非本切片修复):试运行运行中面板 ~10Hz 重渲染对高频自动化输入不友好,建议后续域评估 ProfessionalCodeEditor onChange 稳定化。
- 验收脚本 `verify.mjs` 会在默认项目留下场景『H-C6-S1 热插接线验收 20261002』与一枚脚本(新增物,未改动既有资产)。

## H-C6-S1 行还剩什么

- 快照恢复与热插交互(App 级 Play 退出恢复时对作者会话的处理——当前两域互斥,风险低)。
- Monaco 常态路径下的自动化验收(本次走降级编辑器)。
- H-C6-S1 整行其余切片按总计划推进(快照交互/多模块热插已在总spec列后续刀)。
