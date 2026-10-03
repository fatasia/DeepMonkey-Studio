# G2 源码写回通道审计与收口（G2-source-write，2026-10-02）

- 线路：估时表 G 系列 A 行（G2-source-write，2–4h 高信心）
- 底座：commit `7ecb030b`（G2-S2a 遗留收口 + 保存门禁）+ 本机未跟踪资产 `apps/web/src/components/behaviorGraphDraft.ts`（**只读参考，未改动**）
- 分支 main，起点 HEAD `78e75379`；本任务零 commit
- 结论先行：**7 条通道，2 条收口，5 条保留（含合法专业 JS 通道不误杀）**；新增 3 条回归测试，G2 相关 + scripting 119 测绿，web typecheck 0 错

---

## 一、现状核查（六步，全部执行）

1. **全仓 grep**：`InteractionEditor`（9 文件）、`guardRestrictedCodeWrite` / `isRestrictedInteractionScript` / `parseRestrictedInteractionScript` / `RESTRICTED_GRAPH_PREFIX`（全引用点逐一核过）；`interactions` 状态消费方 30 文件逐一分辨读/写。
2. **契约层**：`packages/contracts/src/scene.ts:895` `SceneInteractionScriptState { id/name/target/trigger/enabled/actions?/code }`——受限图骑在 `code` + `actions` 两字段上，**零合同改动**。
3. **依赖**：零新依赖（门禁复用既有 `restrictedInteractionDocument` + `behaviorGraphDraft`，均为仓内模块）。
4. **消费方**：`InteractionEditor` 唯一挂载点 `AppStudioInspector.tsx:421`（`onChange={setSceneInteractions}`）；运行时消费 `restrictedPlayConsumer` / `viewerEngineInteraction:197/211`（受限脚本不走可信 JS 执行链）。
5. **测试与证据**：底座 42 测（InteractionEditor 6 + BehaviorGraphEditor 9 + behaviorGraphDraft 27）起点全绿。
6. **规格**：`docs/specs/g2-behavior-authoring-design-20260930.md` §0 明记 G2-S1 已知洞「`updateSelected({code})` 直写不过门禁」，已由 `7ecb030b` 修复（`guardRestrictedCodeWrite` 落位）。**本审计证明：该修复只覆盖了 `code` 字段，`actions` 字段仍是敞口。**

**已有（不重建）**：`updateSelected` code 门禁、BehaviorGraphEditorSection 双页签 + 保存门禁（按钮禁用 + commit 双保险）、`behaviorGraphDraft` 变换层与 `guardRestrictedCodeWrite`、SSR 测试范式。

**真实缺口**：①受限脚本可经「添加动作」混入可信预定义动作（见 W3）；②`addRestrictedGraphScript` 直写不经门禁（W4，纵深防御）。其余通道核查为保留项。

---

## 二、写回通道审计矩阵

「门禁」判定标准：写入 `SceneInteractionScriptState` 前，凡结果落在受限域（`/* @bim-studio/restricted-graph/` 前缀）必须过 `parseRestrictedInteractionScript` 全量权威校验，非法文档 0 条落库（7ecb030b 建立的纪律）。

| # | 通道 | 入口（文件:行，修复后行号） | 写入内容 | 修复前门禁 | 风险 | 处置 |
|---|---|---|---|---|---|---|
| W1 | 图编辑器双页签提交 | InteractionEditor.tsx:271 `BehaviorGraphEditorSection onCommit → updateSelected({code})` | 受限图 JSON | ✅ 双门禁（Section 内 `gateBehaviorGraphCode` + `guardRestrictedCodeWrite`） | 低 | **保留** |
| W2 | 可信 JS 源码编辑器 | InteractionEditor.tsx:280 `ProfessionalCodeEditor onChange → updateSelected({code})` | 作者 JavaScript | ✅ 经 guard；非受限前缀直通（**合法专业 JS 通道，不误杀**）；受限前缀被全量校验拦截 | 低 | **保留** |
| W3 | 可信预定义动作增/改/删 | InteractionEditor.tsx:124–139 `addAction`/`updateAction`/`removeAction → updateSelected({actions})` | `actions` 字段 | ❌ **缺口：仅拦 `patch.code`，`actions` 敞口**——选中受限图时点「添加动作」，混用文档（违反解析器 `script.actions?.length` 互斥规则）直落库，Play 时才报错且文档已持久化 | **高** | **收口（双保险，见 §三）** |
| W4 | 新建受限行为图 | InteractionEditor.tsx:105–141 `addRestrictedGraphScript` **直写 `onChange`** | `code: newRestrictedGraphCode()` | ⚠️ **纵深防御缺口**：绕过 `updateSelected`，不经 guard（当前产物为确定性合法空图，但生成器若漂移则非法文档静默落库） | 低 | **收口（生成后过 guard）** |
| W5 | 重置脚本 | InteractionEditor.tsx:123–127 `resetSelectedCode → updateSelected({code})` | 全新空图 / 可信默认模板 | ✅ 经 W1 同一 updateSelected 门禁 | 低 | 保留 |
| W6 | 触发器选择新建脚本 | InteractionEditor.tsx:73–78 `selectTrigger` 直写 `onChange` | `defaultInteractionCode` 可信模板 | 通道级直写，但内容恒为可信域（`createInteractionScript` 确定性模板，永不携带受限前缀） | 低 | 保留（可信通道） |
| W7 | 事件名 / 启用开关 | `updateSelected({name/enabled})` | 元数据字段 | 解析器不消费 `name`/`enabled`，不影响受限文档结构 | 无 | 保留 |

### InteractionEditor 之外的同域通道（记录，不在收口范围）

| # | 通道 | 入口 | 内容 | 判定 |
|---|---|---|---|---|
| W8 | 钻取向导批量建交互 | `studio/sceneDrillAuthoring.ts:45` | `code: ""`（可信空脚本 + 预定义动作） | 可信域，保留 |
| W9 | 交互流向检查器 | `components/InteractionFlowInspector.tsx:93` | `defaultInteractionCode` 可信模板 | 可信域，保留 |
| W10 | 持久化导入/规范化 | `interactionState.ts:77` `normalizeInteractionScripts`、`controllers/sceneImportRebinding.ts:45` | 原样保留 `code`（authoring 门禁不适用于读盘；非法受限域由 Play 消费端 `restrictedPlayConsumer` 权威报错兜底） | 非写回通道，不动 |
| W11 | AI 草案 | 无直写通道（`ai/assistantSuggestions.ts` 仅建议文案；AI 产物经用户在编辑器内落库即走 W1/W2） | — | 无敞口 |

---

## 三、收口实现（最小修复）

### 修复 1（W3 数据门禁）：`updateSelected` 增补 actions 互斥拦截

```ts
if (patch.actions !== undefined && isRestrictedInteractionScript(selected) && patch.actions.length > 0) {
  setCodeGateError(RESTRICTED_ACTIONS_MIX_MESSAGE);
  return;
}
```

- 拦截消息 = 新增导出常量 `RESTRICTED_ACTIONS_MIX_MESSAGE`（`restrictedInteractionDocument.ts`），解析器抛错与编辑器门禁**同一字符串**，杜绝双写漂移；回归测试断言两者逐字节一致。
- 清空动作（`length === 0`）放行：为历史混用脏数据留 UI 外的自愈路径（重置/删除不受影响）。

### 修复 2（W3 UI 防呆）：受限脚本不渲染可信动作区块

解析器规则本意即「受限图动作在图内白名单管理」，可信动作控件对受限图无意义。`interaction-actions` 区块改为仅可信脚本渲染；页脚对受限脚本显示「动作由受限行为图管理」（替代误导性的「已配置 0 个内置动作」）。

### 修复 3（W4 纵深防御）：`addRestrictedGraphScript` 生成产物过 guard

`newRestrictedGraphCode()` 产物先过 `guardRestrictedCodeWrite`，被拦则 `setCodeGateError` 并原地 return——生成器漂移时非法文档 0 条落库，与其他 code 写通道同一纪律。

### 明确不做的（防误杀）

- W2 可信 JS 编辑器**保留全功能**（ProfessionalCodeEditor、智能提示、Ctrl+Enter 测试），guard 对非受限前缀直通。
- W6 触发器新建脚本保持直写（内容恒为可信模板，加门禁是死代码）。
- 未引入「受限脚本全字段重解析」：历史非法脏数据仍可改名/启停（修复入口与阻断横幅保持 7ecb030b 行为），只在写入非法结果时拦截。

---

## 四、回归测试与验证

新增（`InteractionEditor.test.tsx`，6 → 9 条）：

1. `权威措辞单一事实来源`：混用文档经 `parseRestrictedInteractionScript` 抛错 message === `RESTRICTED_ACTIONS_MIX_MESSAGE`（编辑器与解析器同源实证）。
2. `受限脚本:可信动作添加区不渲染` + 页脚归属声明 + 图编辑器不受影响。
3. `可信脚本:动作添加区保持原样`（合法专业 JS 通道不误杀的反向断言）。

验证结果（2026-10-02）：

- G2 相关 + scripting 全目录：**9 文件 119 测全绿**（含底座 42 测零回归）
- web 全量 `vitest run`：**5308 过 / 1 失败 / 3 跳过（857 文件）**——唯一失败为 `src/architecture.test.ts > recursively uses public package APIs`，违规文件是其他线路的在制未跟踪文件（`controllers/sceneRendererRecoveryFullDomains.test.ts`、`delivery/pathTraceAuthorSession.test.ts`），**与本线路改动的三个文件无关**（不在违规清单）；本线路相关 119 测全绿零回归
- `npx tsc --noEmit`：**0 错**
- `behaviorGraphDraft.ts`（用户未跟踪资产）：**未改动**（`git status` 复核确认）

## 五、剩余缺口（诚实声明）

- W3 数据门禁的「点击级」行为（点击添加→拦截提示）无法在 SSR 范式下验证，由 B 线 headless 视觉脚本以「控件不渲染」结构断言覆盖；`updateSelected` 内 3 行拦截逻辑的分支覆盖依赖同源常量测试 + UI 防呆双保险，未做单测直击（如需可用 jsdom 引入后补）。
- W10 导入通道保留原样是有意决策（authoring 门禁不约束读盘），非法导入文档的编辑器内呈现由既有「阻断横幅」路径覆盖（BehaviorGraphEditor 测试已断言）。
