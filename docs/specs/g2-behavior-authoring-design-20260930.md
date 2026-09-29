# G2「Blueprint 级可视化行为编排」精华调研 + 巧架构设计稿

日期:2026-09-30 · 状态:**设计稿(评审前,未立项)** · 前置:T31(受限行为图运行时)、G2-S1(只读行为图,已交付)、T30(Play 状态机)、T28(录制回放先例)
本文只做设计,不含实现代码;评审通过后才切片立项。不 commit 不 push。

---

## 0. 现状核查(六步,2026-09-30 全部执行)

1. **全仓 grep**(`BehaviorGraphView`/`behaviorGraph`/`xyflow`/`restricted-graph`,含未跟踪文件):
   - 生产在用面确认:`apps/web/package.json` 已有 `@xyflow/react@12.12.0`(精确固定)+ `@dagrejs/dagre@3.1.1`;`BehaviorGraphView.tsx`(213 行)与 `behaviorGraphProjection.ts`(461 行)为 **G2-S1 已交付的只读图视图**(`docs/reports/G2-S1-只读行为图-20260928.md`),挂在 `InteractionEditor.tsx` 的「受限行为图 · 只读视图 / 源码 JSON」双页签(513 行)下。
   - 执行链全在 `apps/web/src/scripting/`(10 源文件 + 5 测试):`restrictedEvaluator`(528)、`behaviorGraph`(438,校验器)、`behaviorTraceLog`(164)、`behaviorGraphRuntime`(542)、`playModeScriptRuntime`(101)、`restrictedInteractionDocument`(93,`restricted-graph/v1` 契约)、`restrictedPlayConsumer` + `restrictedCommandAdapter`(宿主命令适配,已交付)。
2. **契约层**:受限图骑在既有 `SceneInteractionScriptState.code`(`packages/contracts/src/scene.ts`)上,前缀标记 `/* @bim-studio/restricted-graph/v1 */` 区分可信 JS;**本设计零合同改动**。
3. **依赖**:`@xyflow/react` 12.12.0 + `@dagrejs/dagre` 3.1.1 已随 G2-S1 引入,**零新依赖**。
4. **消费方**:`viewerEngineInteraction.ts:197/211` 对受限脚本跳过可信 JS 执行;`App.tsx` 已接 `createRestrictedPlayConsumer`(Play 消费链已上线);`BehaviorGraphView` 唯一消费方是 `InteractionEditor` 图页签。
5. **测试与证据**:G2-S1 报告——新增 28 测 + 全仓 web 4894 绿 + `tsc` 0 错 + 256 节点投影 58–65ms;T31 报告——scripting 64 测 + 确定性全等实证。**已知缺口(诚实声明)**:G2-S1 未过浏览器视觉闭环(边样式、256 节点交互帧率待真机);保存回路(`InteractionEditor.updateSelected({code})`)目前**直写不过门禁**——受限图源码 JSON 可编辑,但坏 JSON 能落库,靠 Play 预校验兜底。
6. **规格文档**:T31 报告 §十 剩余子项(1 宿主适配已交付、2 Play 接线已交付、3 持久化已随 `code` 字段自动生效、**4 轨迹 UI 面板未做**、5 点键盲区未做、6 Native 通道后续波次);G2-S1 §7 预告 S2=「调色板 + 白名单参数表单 + 保存回路」;主计划 §9(2026-09-27)边界修订明确「C#/Blueprint 通用语言仍排除」,T31 承接 C1+C3+E3。G 级教训(Godot VisualScript 移除 → 纯视觉编程非答案,数据优先 + 代码优先双通道才是精华)来自已散佚的 G 级设计底稿(被 G2-S1/G1-S1 报告引用,原件不在仓),本稿 §1 以官方来源重新锚定该教训。

**已有(不重建)**:T31 全部执行面(求值器/校验器/运行时/轨迹/Play 桥/命令适配)、G2-S1 只读图视图(投影 + dagre 布局 + issue 定位 + 零写回纪律)、`restricted-graph/v1` 持久化契约、可信 JS 通道的隔离层、T28 录制/回放面板先例(环形缓冲、时间轴、逐帧重申防作者态回写)、T17 格式导出导入纪律。

**真实缺口(=G2 全部增量)**:①图页签只读 → 可编辑(调色板/节点增删/参数表单/连线/删除);②保存回路全量校验门禁(坏文档不可落库);③表达式编辑体验与错误定位闭环(词法偏移 → 节点内);④热重载语义(Play 中编辑的行为规则,当前未定义);⑤轨迹回放 UI(T31 E3 数据面已有,消费面为零)。

---

## 1. 对标精华提炼(官方来源,机制层)

> 提炼原则:只取「机制层」(为什么这样设计、我们的架构能借什么),不抄「产品层」(菜单/交互皮肤)。每家注明官方来源与可借鉴机制。

### 1.1 Unreal Blueprint —— 数据驱动图 + 显式编译 + 在位重编译

官方来源:
- Blueprints Visual Scripting 概览:「a complete gameplay scripting system based on the concept of using a node-based interface」——https://dev.epicgames.com/documentation/en-us/unreal-engine/blueprints-visual-scripting-in-unreal-engine
- Blueprint Compiler Overview:Compile 按钮 →「converting the properties and graphs of a Blueprint asset into a class」;节点编译为 `FKismetCompiledStatement`,后端「Converts FKCS to UnrealScript VM bytecode which are then serialized into the function's script array」;「Classes are compiled in place … the same UBlueprintGeneratedClass is cleaned and reused over and over」——https://dev.epicgames.com/documentation/en-us/unreal-engine/compiler-overview-for-blueprints-visual-scripting-in-unreal-engine
- 运行时热改代码走 Live Coding(旧 hot reload 已退场)——https://dev.epicgames.com/documentation/unreal-engine/using-live-coding-to-recompile-unreal-engine-applications-at-runtime

**可借鉴机制层**:①**图是资产(纯数据),编译产物才是可执行类**——编辑态与运行态严格分离;②**显式 Compile 门禁**:编译失败不影响旧产物,运行时永远只见过编译通过的产物(我们映射为:保存即过 `parseRestrictedInteractionScript` 全量校验,非法图不可离开编辑器);③**在位重编译 + re-instance**:重编译复用同一产物对象,外部引用不断(我们映射为:`CompiledBehaviorGraph` 重建只会发生在「会话重建」边界,不发生在会话中途)。

### 1.2 Blender Geometry Nodes —— 图即数据块 + 惰性字段语义 + 类型可视化

官方来源:
- 几何节点简介:「Geometry Nodes is a system for modifying the geometry of an object with node-based operations … The geometry node tree connected to a modifier is a Node Group」(节点组是随文件持久化的数据块,经 Group Input/Output 与宿主交换数据)——https://docs.blender.org/manual/en/latest/modeling/geometry_nodes/introduction.html
- Fields 概念:「Fundamentally, a field is a function … A field's result can then be calculated many times with different input data … calculations that have different results for every element」;字段 socket 连线画虚线、类型错误画红线——https://docs.blender.org/manual/en/latest/modeling/geometry_nodes/fields.html

**可借鉴机制层**:①**节点树 = 宿主文档的一个数据块**,挂载(modifier)即消费——我们已同构(`restricted-graph/v1` 骑 `interaction.code`);②**socket 的类型/语义可视化**(虚线=惰性字段、红线=类型错误)映射为:我们三型节点卡(event=accent/condition=钢蓝/action=绿)已有,增量是**表达式错误在节点卡上的原位呈现**(错误消息与偏移来自受限求值器,不转写);③**字段=惰性求值**提醒我们:不是所有连线都要「每条边每帧执行」——我们的图是事件驱动 DAG,边只表达「可达与求值序」,这与 T31 运行时语义一致,不引入数据流 push 语义。

### 1.3 TouchDesigner —— 按需 cook + cook 可观测性 + 节点网络与 Python 双通道

官方来源:
- Cook:「Cooking is the term in TouchDesigner used for computing or calculating the operators of networks」;「TouchDesigner will cook a node only when it needs to - it doesn't cook every node every frame」;pull 系统语义;「Middle-click on a node to see how long it last cooked, and how many times it cooked」——https://docs.derivative.ca/Cook
- 节点网络的 Python API(`OP` 类):节点网络之外始终存在代码通道,两者共存——https://docs.derivative.ca/OP_Class

**可借鉴机制层**:①**执行成本内建可观测**(节点上直接看 cook 次数/耗时)——我们映射为:节点卡上透传运行时预算与轨迹命中计数(轨迹日志已有 `graphId/eventNodeId/actionNodeId` 粒度,展示即可,零新执行语义);②**节点网络(数据工程面)与 Python(代码面)共存**正是 G 级「双通道」结论的工业实证——但注意 TouchDesigner 的 cook 是**每帧 pull 的通用数据流网络**,这正是我们 §4 明确不做的;我们只借「可观测性」不借「通用 cook」。

### 1.4 Unity —— authoring 框架与执行语义分离;运行时图语言退场

官方来源:
- Graph Toolkit(官方图编辑器框架,基于 GraphView,Unity 6.2 起实验包、6.4 起内建编辑器模块):「framework for building node-based graph tools in the Editor」,**无执行语义**——https://docs.unity3d.com/Packages/com.unity.graphtoolkit@0.1/manual/introduction.html ;https://docs.unity3d.com/6000.6/Documentation/Manual/gtk/gtk-index.html
- Visual Scripting(原 Bolt)在 Unity 6 仍有文档但官方信号显示 Unity 7 起弃用、无重大更新计划——https://docs.unity3d.com/6000.6/Documentation/Manual/com.unity.visualscripting.html ;https://discussions.unity.com/t/will-unity-visual-scripting-receive-any-major-updates-in-the-future/1710695

**可借鉴机制层**:①Unity 官方的资源投向是「**编辑器 authoring 框架**」而非「第二运行时脚本语言」——与我们「图=authoring 表面、T31=唯一执行面」同构;②两大引擎的运行时视觉脚本语言相继退场(Godot 移除、Unity 停更),反向印证 G 级表教训。

### 1.5 Godot VisualScript —— 反面教材(G 级教训的官方锚点)

官方来源:Godot 4.0 Alpha 15 官方快照公告:「VisualScript: Remove VisualScript module as announced on the blog (GH-64822)」——https://godotengine.org/article/dev-snapshot-godot-4-0-alpha-15/ (移除动因:维护者缺位、采用率低,官方转向 GDScript/C# 代码优先,视觉层交给第三方 GDExtension 生态)。

**教训机制层**:把「视觉」做成**第二门语言**(自带解析器/VM/维护负担)必死;把「视觉」做成**既有数据契约的投影 + 既有运行时的 authoring 表面**才活。G2-S1 的只读图(图=JSON 第二视图)已站在正确一侧,G2 的全部增量继续站在这一侧。

### 1.6 对标结论(一句话版)

**视觉层的价值在「authoring 表面 + 可观测性」,不在「第二执行语义」。** Blueprint 的显式编译门禁、Blender 的数据块与类型可视化、TouchDesigner 的成本可观测、Unity 的 authoring/执行分离,四条机制全部可以落在「T31 白名单运行时为唯一执行面」之上;Godot/Unity 的运行时图语言退场,划清了我们不做什么。

---

## 2. 我们的巧架构

### 2.1 单一执行面(第一原则)

**T31 白名单运行时是本产品唯一的行为执行语义。** 视觉图只是 `restricted-graph/v1` JSON 的 authoring 表面,产物仍是 JSON 文档;执行永远走既有链:

```
图编辑器(authoring 表面)
  → 产出 restricted-graph/v1 文档(唯一真值,骑 SceneInteractionScriptState.code,零合同改动)
  → parseRestrictedInteractionScript(文档级门禁:标记/64KiB/深度 16/fail-closed 不回退可信 JS)
  → validateBehaviorGraph(结构仲裁:7 类规则 13 issue code,校验器唯一仲裁)
  → CompiledBehaviorGraph(T31 编译产物)
  → BehaviorGraphRuntime(T31 确定性运行时:预算 20k 步/64 动作/重入 ≤4/tick 追赶 ≤16)
  → restrictedCommandAdapter(宿主命令适配,已交付)
  → 轨迹日志 behaviorTraceLog(E3,seq/atMs/前后值摘要)
```

UI 层零新增执行语义:不新增动作类型、不新增边语义、不新增求值规则、不新增预算。白名单扩充走 T31 同款评审切片,与本设计解耦。

### 2.2 双通道(视觉 ↔ 受限代码)

- **真值唯一**:`interaction.code` 里的 `restricted-graph/v1` JSON 文档。React Flow 画布状态**不是真值**——所有编辑操作都是「产生新文档草案」的纯函数变换(G2-S1 投影模块已确立「投影=纯函数、同输入同输出」纪律,编辑侧沿用同一纪律的反向:变换=纯函数,文档进文档出)。
- **双视图共存**:图页签(视觉通道:调色板/节点卡/连线/属性表单)与源码 JSON 页签(代码通道,G2-S1 已保留)是**同一文档的两个投影**,切换零丢失——比 Blueprint 更强:Blueprint 没有文本通道,我们天然有,且是同一份真值。
- **表达式一律文本 + 即时校验**:condition 表达式、`set-value` 表达式、`emit-event` payload、`set-opacity` 表达式在属性表单中是文本输入,键入时经 `restrictedEvaluator` 编译校验,词法/语法错误带偏移原样透传,定位到所属节点卡(不转写消息,校验器唯一仲裁纪律的延伸)。**不做表达式可视化积木**(见 §4)。
- **保存回路门禁(G2-S1 §7 预告的缺口)**:`InteractionEditor` 对受限脚本的一切写路径(图编辑产生的草案、源码 JSON 手编)落库前必须通过 `parseRestrictedInteractionScript`;失败则停在编辑器内(错误原样呈现),**非法文档 0 条落库**。可信 JS 通道写路径一字不动。

### 2.3 热重载语义(分级定义,确定性优先)

T31 确定性证明的前提是「会话状态 = 图编译产物 + 初始变量 + 注入时钟 + 事件序列」。任何**会话中途换图**都会替换证明前提、迫使定义变量迁移/tick 重锚定等新语义——违反第一原则。故热重载分级如下:

| 场景 | 语义 | 对标 |
|---|---|---|
| 编辑态(非 Play)保存 | **即时生效**:图本来就是 Play 进入时才编译装载(T31 §六),保存的新文档在下一次进入 Play 时自然生效,零额外机制 | — |
| Play 运行中编辑 | **不热换**。编辑进草稿态,UI 明示「Play 运行中,改动将在退出后应用」;退出 Play 按既有语义丢弃会话(`playModeScriptRuntime`:stop 并丢弃),再次进入装载新图 | Blueprint Compile 门禁:编辑态与运行态分离,失败/未应用不影响旧产物 |
| Play 运行中「重启会话」 | 可选快捷入口 = 既有 stop→start 的组合,**不新增语义**(显式重建会话,如同 Blueprint 在位重编译发生在类边界而非执行中途) | Blueprint 在位重编译 + re-instance |

明确否定 TouchDesigner 式「改一笔立即热 cook」:那要求运行图可变,与确定性回放(§2.4)互斥。我们要的是「每次运行的轨迹都可复现可审计」,不是「所见即所得的实时调参」。

### 2.4 确定性回放(轨迹为真值,T28 为面板先例)

- **回放真值 = 轨迹日志**(`BehaviorTraceEntry` 序列:`seq`/`atMs`/`graphId`/`eventNodeId`/`actionNodeId`/`action`/`before`/`after`/`outcome`/`reason`,环形缓冲,确定性序列化)。运行时确定性(T31 已实证:同图同初态同事件序列 → 命令与轨迹逐字段全等)保证轨迹本身就是可审计的运行记录。
- **回放面板 = 审阅器,不是第二运行时**(T28 物理调试面板为 UI 先例:时间轴 scrub、上一条/下一条步进、暂停粒度控制):按 seq/时间轴浏览,每条命令展示 before/after 摘要与 outcome(applied/skipped/rejected + reason),条件判假落规则级 skipped、动作逐条落 applied/rejected 的粒度沿 T31。
- **回放不改场景状态**:纯审阅视图。这天然规避 T28 实测教训(回放写入被作者态同步路径回写,被迫逐帧重申)——行为轨迹回放第一版不写场景;若未来要「重演」,语义是**重开 Play 会话重喂同一事件序列**(运行时确定性保证输出全等),仍不走「回放写场景」路径。
- **导出**:轨迹 JSON 落盘,沿用 T17/T28 导出纪律(确定性序列化、与消费流程逐字段同构),供离线比对与缺陷工单附件。

### 2.5 编辑器数据流(描述,非代码)

受控 React Flow 模式:画布变更事件(onNodesChange/onEdgesChange/onConnect)→ 纯变换函数(文档草案 → 新文档草案)→ 保存门禁校验 → 通过则落 `onChange`(既有 `updateSelected({code})` 路径,加门禁)→ 失败则草案保留在编辑器内并呈现权威 issue。投影复用 G2-S1 的 `behaviorGraphProjection`(dagre 确定性布局,新增节点用固定增量坐标,不破坏同输入同输出;布局函数只在文档提交时重算,键入期间 memo)。xyflow 只读开关(五项全 false)仅对**合法已保存文档**的审阅态保留;编辑态按需翻转且同样不提供任何绕过文档草案的写回通道——图上永远画的是「某一份文档的投影」,不存在游离于文档之外的画布真值。

---

## 3. 可验证增量清单(每条:提升什么指标、多少算达标)

| # | 增量 | 提升的指标 | 达标线 |
|---|---|---|---|
| 1 | 图页签只读 → 可编辑(调色板 3 事件 + 9 动作、节点增删、参数表单、连线、删除) | 授权效率:完成一个「数据变化→条件→动作」图全程不触 JSON 文本 | 12 类节点全可配;全程图页签完成率 100%(验收剧本实测);新授权耗时对比手写 JSON 有可数下降(剧本计时) |
| 2 | 保存回路全量校验门禁 | 编辑正确性:非法文档落库数 | **0 条非法文档可落库**(门禁测试证明);既有全仓 web 测试(≥4894)零回归;`src/scripting` 全绿不改一字 |
| 3 | 双通道无损往返 | 数据完整性:图编辑→保存→重投影的语义等价 | ≥20 个代表性图(含 256 节点夹具、全部非法定位用例)往返后语义字段逐字段相等;通道切换零丢失 |
| 4 | 热重载语义(§2.3) | 运行可信度:Play 中编辑不改变运行中会话输出 | 确定性扩展测试:同图同初态同事件序列,在「编辑事件发生」前后两次会话的命令序列与轨迹逐字段全等;退出再进装载新图 |
| 5 | 表达式通道与错误定位 | 调试效率:表达式错误的定位路径 | 词法/语法错误带偏移,原样透传并定位到所属节点卡;非法表达式节点在画布与 issue 清单双重可见 |
| 6 | 确定性回放面板(§2.4) | 审计能力:任意 Play 会话轨迹可逐条审阅 | 时间轴 scrub + 逐条步进 + before/after + outcome 徽标齐备;1 万条轨迹浏览无明显卡顿(虚拟化,真机);轨迹 JSON 导出与 T17/T28 纪律一致 |
| 7 | 规模不回退 | 大图可用性 | 256 节点/1024 边编辑与审阅真机无明显卡顿(承接 G2-S1 未竟的 256 节点真机闭环,一并补验);投影 memo 命中时零重算 |

验收通用门槛沿主计划 §6.2:全部门禁实跑、`git diff --check` 干净、单文件 ≤800 行、中文注释与仓一致、真机视觉闭环 ≥2 轮(有浏览器工具时)。

---

## 4. 明确不做清单

1. **全功能 Blueprint 克隆**:函数库/宏/ubergraph 合并、继承与接口事件、任意 pin 类型系统、蓝图调试器、蓝图 Nativization——一概不做。
2. **任意代码执行 / 第二执行语义**:不新增求值器、不新增图语义、不新增动作类型、不新增预算规则;白名单扩项走 T31 同款评审,不随编辑器切片搭车。
3. **会话内热换图**(§2.3 已定性:替换确定性证明前提,属新执行语义)。
4. **表达式可视化积木**(Scratch 式拼接):表达式保持文本 + 即时校验;受限求值器语法面(§T31 最小完备)不因 UI 扩容。
5. **断点/单步调试器**:主计划 E3 边界明确「断点/单步不建,先做轨迹日志」;轨迹回放面板是 E3 的消费面,不是调试器的开始。
6. **TouchDesigner 式通用数据流 cook 网络**:我们是事件→条件→动作的语义图,不做每帧 pull、不做通用 operator 家族、不做节点级 cook 开关。
7. **视觉层第二语言**(Godot 教训):不做图专属 DSL、不做图→代码生成器(双通道是同真值双投影,不是两种语言互译)。
8. **Native 侧第二求值器与 deep-engine 接线**:主计划后续波次,不在 G2;本设计所有增量在 `apps/web`(authoring/审阅面),`packages/deep-engine` 零触碰。
9. **多图资产库/市场、图版本管理 UI**:合同层已有 `schemaVersion` 单值,不做图内版本树;快照回滚走既有 Undo(T27)通道。

---

## 5. 分期切片估算(以 G2-S1/T31 实测体量为锚:每切片 1 交付报告 + 全量测试 + 真机闭环)

| 切片 | 内容 | 验收(最小集) | 估算 |
|---|---|---|---|
| **G2-S2a:最小可用编辑回路(第一片)** | 调色板(3 事件 + 9 动作)、节点增删、9 动作参数表单、连线(端型约束 event→condition→action、禁自环/重边,规则复用校验器结论)、删除、保存回路门禁(§3-1/2/3) | §3-1 全程图页签建图剧本;§3-2 零非法落库 + 全仓零回归;§3-3 往返等价;真机视觉闭环 ≥2 轮(顺带补验 G2-S1 遗留的 256 节点真机帧率,§3-7 前半) | **1 个会话**(体量对标 G2-S1:新增/修改 ≈600–800 行 + 测试 ≈30 例) |
| G2-S2b:表达式通道与错误定位 | 表达式文本输入即时编译校验、偏移定位到节点卡、点键盲区按 T31 §十-5 决策(转义或嵌套命名空间,先报告后实施) | §3-5;`restrictedEvaluator` 既有 23 测不改一字仍绿 | 0.5 会话 |
| G2-S2c:热重载语义与 Play 草稿态 | Play 中编辑草稿态 UI、「重启会话」入口、确定性扩展测试(§3-4) | §3-4;`playModeScriptRuntime`/`restrictedPlayConsumer` 既有测试零改动 | 0.5 会话 |
| G2-S2d:确定性回放面板 | 轨迹时间轴、步进、before/after、outcome、轨迹 JSON 导出(T28 面板先例 + T17 导出纪律) | §3-6;T31 轨迹日志测试零改动;真机闭环 ≥2 轮 | 1 会话 |

**合计 ≈3 个切片会话**。第一片(S2a)即可独立评审:交付后「图编辑」从 0 到 1,后续三片各自独立可验收、可叫停,无跨片隐藏依赖。

### 5.1 风险与诚实条款

- 编辑态拖线/拖节点交互在 SSR 静态测试范式下覆盖有限(G2-S1 已声明边样式同类问题),交互细节归真机闭环,验收剧本必须含真实拖线。
- 大图键入期性能:属性表单键入若每键全量重投影可能有压力;采用「键入暂存草案、提交过门禁时重投影 + memo」策略,如真机实测不达标,记入切片报告并回改(不允许静默降级)。
- 未过浏览器视觉闭环的条目(G2-S1 边样式、S2a 拖线、S2d 回放面板)在各自切片报告如实声明,不伪称。

---

## 附:本稿引用的仓内事实

- `docs/reports/deep-core/T31-implementation.md`(执行面边界与剩余子项)
- `docs/reports/G2-S1-只读行为图-20260928.md`(只读图现状、零写回纪律、遗留真机项)
- `docs/reports/deep-core/T28-implementation.md`(录制/回放面板先例、逐帧重申教训、T17 导出格式)
- `docs/specs/deep-engine-core-capability-development-plan-2026-09-27.md` §9(C1/C3/E3 映射与「Blueprint 通用语言排除」边界)
- `apps/web/src/scripting/*`(T31 全链)、`apps/web/src/components/{InteractionEditor,BehaviorGraphView,behaviorGraphProjection}.*`(S1 全链)
