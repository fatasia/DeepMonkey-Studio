# G2-S2a 行为图编辑器五路径视觉验收（B 线，2026-10-02）

- 线路：估时表 G 系列 B 行（G2-S2a visual review），承接 A 线审计 `g2-source-write-audit-20261002.md`
- 底座：A 线收口后工作区（`InteractionEditor.tsx` / `restrictedInteractionDocument.ts` / `InteractionEditor.test.tsx`，未 commit）；`behaviorGraphDraft.ts` 全程只读未动
- 结论先行：**五路径（拖入/连线/改表达式/保存/非法拦截）两轮独立截图全部通过**（`round{1,2}/report.json` passed=true，各 8 张路径截图逐张人工复核）；修复 B 线断点 4 处 + **产品 CSS 缺陷 1 处（窄画布 minimap 遮挡，同族含只读视图）**；45 项行为图 SSR 测试零回归，web 构建 + `tsc --noEmit` 0 错

---

## 一、现状核查（断点恢复）

1. A 线审计已读：7 通道、2 收口（W3 actions 互斥 + W4 纵深防御）、119 测绿 + tsc 0 错；`git status` 确认三个收口文件改动在工作区，无待修项遗留。
2. B 线断点：`round1/` 只有 p0/p1 两张截图；`gate-run.log` 显示 p2 连线第一段 `mouse.down` 命中的是 condition 卡片而非 data-change 的 source handle（节点叠压：三节点 screen 坐标 x 1664 vs 1683、同宽 209、同 y，handle 仅 6.7px 被对方卡片盖住），只连出 1 条边后 224 行 `waitForFunction(edges===2)` 30s 超时崩溃。
3. 已有（不重建）：`isolatedStudioGate` 隔离基建（独立端口/数据目录/`OBJECT_STORE=local`，`gate.close()` 用完即关，实测结束后 0 个 node 进程、无残留监听）；gate 脚本五路径骨架与 A 线 W3 探针。
4. 真实缺口：脚本布局策略（窄画布 237×320 放 209px 宽节点 ×3 必然叠压）、连线命中健壮性、P4b/P5 断言对象错位、**产品窄画布 minimap 遮挡**。

## 二、产品修复（1 处，同族同修）

**`apps/web/src/styles/platform-components.css`（minimap 窄画布让位）**

- 事实：右检查器内嵌画布约 237px 宽，固定 118×92 minimap 占比过半，与多节点布局几何冲突（遮节点或被节点遮挡）；且 React Flow v12 拖动过的节点 z 提升至 1000，反盖 Controls（z 5），fitView 按钮不可点。270px 画布上三节点布局与右下角面板组件的冲突**在几何上无解**。
- 修复：`.behavior-graph-view, .behavior-graph-editor { container-type: inline-size; }` + `@container (max-width: 359px)` 下 minimap `display:none`——窄画布自动让位，宽画布保留全功能；只读视图与编辑器同族同修。不含新颜色，不触碰设计令牌。
- 验证：BehaviorGraphEditor/InteractionEditor/behaviorGraphDraft 45 测全绿（display:none 不影响 SSR DOM）；web 构建（含 tsc 0 错 + bundle budget）通过；两轮截图确认 minimap 让位、Controls 完整可读。

## 三、B 线断点修复（gate 脚本 `apps/web/scripts/g2-s2a-visual-gate.mjs`，4 处）

| # | 问题（实测证据） | 修复 |
|---|---|---|
| 1 | 节点叠压致拖排/连线双失败（round1 死因） | `arrangeFlowLayout`：穿透命中目标节点（`elementFromPoint` + 临时 pointer-events:none，恢复走 window 暂存）拖成贴左竖列（间距 ~120px），断言无叠压且画布内完整；连线起点同样穿透校验，up 后 5s 快速断言边数（替代 30s 盲等），失败带 DOM 诊断 |
| 2 | 画布 bottom 超出 1080 视口（pane 曾到 1308），截图截断、手势落点在视口外 | `ensurePaneInView`：截图/连线/表单前把画布滚入视口 |
| 3 | P5 断言对象错位：issue-list 在 `projection.parseError` 时**有意隐藏**（渲染条件 `!projection.parseError`），权威理由在状态栏；P4b 等待被页面底部固定说明文字（含 restricted-graph\/v1 字样）误满足，拍到「正在加载源代码智能服务」加载态 | P5 改断言状态栏 `is-error` 项含「非法」；P4b 改等 `.professional-code-editor[data-content-fingerprint]`（monaco 挂载即含完整值） |
| 4 | P5b 拖线悬停 ✕ 理由拍不到：`parseError` 会短路状态栏 hover 项（先按真实用户路径恢复合法表达式）；且 **DOM 已更新 ≠ 已上屏**——`page.screenshot` 捕获最近合成帧，React 提交后像素滞后，拍到旧状态 | 恢复合法表达式后再测重复边；每轮微移 1px 主动重建 mouseover → 等 ✕ 理由 → 双 rAF 等新帧提交 → 截图 → 拍后采样状态栏确认理由仍在，6 轮内命中，保底断言（round1 一次命中，round2 第 3 次命中） |

另有顺手修复：catch 分支 `failure.png` 因 `const page` 遮蔽外层 `let page` 而从未生效，改为赋值。

## 四、截图清单与逐轮复核（16 张全部 Read 人工检查）

两轮均为独立项目/场景（round1 项目 `88c050d2…`、round2 项目 `fc304100…`）、1920×1080、`data-theme=dark` 断言锁定、独立隔离端口与数据目录。

| 路径 | round1 | round2 | 复核要点（两轮一致） |
|---|---|---|---|
| P0 空图 | `round1/p0-empty-graph.png` | `round2/p0-empty-graph.png` | 「校验通过 · 节点 0/256 · 边 0/1024 · 最长路径 0/16」；调色板事件/条件/动作三组完整；深色 |
| P1 拖入 | `round1/p1-drag-in.png` | `round2/p1-drag-in.png` | 三节点竖列无叠压，红色 issue 角标与状态栏 3 条问题文案可读（未连线即有问题=正确语义） |
| P2 连线 | `round1/p2-connect.png` | `round2/p2-connect.png` | 两条竖直连线带端点清晰；issue 消除；「校验通过 · 边 2/1024 · 最长路径 2/16」+ 保存 ready |
| P3 改表达式 | `round1/p3-expression.png` | `round2/p3-expression.png` | 节点表单「条件 condition-1」+ `values.temperature > 80` accent 高亮、无行内错误 |
| P4 保存 | `round1/p4-saved.png` | `round2/p4-saved.png` | 「已保存」禁用态 + Ctrl+S 徽标 + 校验通过 |
| P4b 源码同源 | `round1/p4b-saved-source.png` | `round2/p4b-saved-source.png` | 源码 JSON 页签 + monaco「检查通过」徽标 + `/* @bim-studio/restricted-graph/v1 */` 文档行 1-10 肉眼可见 |
| P5 非法拦截 | `round1/p5-illegal-blocked.png` | `round2/p5-illegal-blocked.png` | 三重反馈同屏：行内错误「第 1 行 第 21 列 · 表达式意外结束」+ 状态栏红色「受限行为图校验失败：条件表达式非法…(偏移 20)」+ 保存禁用 |
| P5b 重复边拒绝 | `round1/p5b-connect-reject-hover.png` | `round2/p5b-connect-reject-hover.png` | 按住拖线悬停：状态栏「✕ 两条节点之间已存在连线(重复边)」清晰可见；松手不新增边（断言 edges===2） |

逐张检查项：溢出/遮挡/截断/对比度/错误提示可见性。发现并修复后重拍的问题：

- round1 第一轮产物：p1 节点叠压（重拍，§三-1）；p4b 加载态（重拍，§三-3）；p5b hover 理由丢失（重拍，§三-4）。
- round2 一次通过（p5b 第 3 次采样命中），无重拍。
- A 线 W3 结构探针两轮均过：受限脚本选中时可信动作添加区 0 个、页脚「动作由受限行为图管理」。

**已接受事实（如实声明）**：p2/p4b 面板最底部一行辅助说明文字被 1080 视口裁半——右面板内容总高大于视口是产品实况，被验收要素全部完整，真实用户可滚动；不构成截断缺陷。

## 五、10 维自评（逐维 ≥9/10 方可交付）

| # | 维度 | 分 | 依据（实测） |
|---|---|---|---|
| 1 | Design Read / 现状核查 | 9.5 | 断点三处证据链复原（log/report/git），A 线结论复用不重做；基建复用零重复建设 |
| 2 | 主题与令牌合规 | 9.5 | `assertDark` 两轮锁定；产品 CSS 修复不含新颜色、沿用库变量与既有深色体系 |
| 3 | 布局与信息密度 | 9 | 窄画布竖列布局间距均匀、节点/连线/状态三层信息分明；扣 1 分：270px 面板宽度是产品既有布局，可读性上限受制于它 |
| 4 | 遮挡控制 | 9 | 叠压清零（断言强制）、minimap 窄画布让位、Controls 不再被 z 反盖；底部说明文字裁半为已接受事实（§四） |
| 5 | 对比度可读性 | 9 | 深底浅字两轮 16 张全部清晰；issue 红/事件金/动作绿语义色可辨；8px 小字号为产品既有密度体系 |
| 6 | 错误反馈可见性 | 9.5 | P5 三重反馈（行内行列/状态栏权威理由/保存禁用）与 P5b ✕ 重复边理由，两轮全部肉眼可见 |
| 7 | 交互闭环真实性 | 9.5 | 真实 DOM 事件链：合成 DragEvent 拖入、原生鼠标按住拖线、真实点击保存/页签；强点禁用按钮验证 0 落库；A 线 W3 探针每轮复验 |
| 8 | 两轮独立与可复现 | 9.5 | 独立项目/场景/端口/数据目录，round 互不污染；脚本幂等，round2 一次通过复证 round1 修复非偶然 |
| 9 | 证据链 | 9 | 16 张截图逐张人工复核 + 双轮 report passed=true + 45 测 SSR 零回归 + 构建/tsc 通过；扣 1 分：截图像素与 DOM 状态的一致性靠「拍后采样」旁证，未做逐像素断言 |
| 10 | 诚实条款 | 9.5 | 全部失败轮、重拍原因、已接受事实、剩余缺口如实落档 |

**结论：10/10 维 ≥9，通过。**

## 六、剩余缺口（诚实声明）

1. p5b「红端口」颜色态在 7px 端口上，1920×1080 全景截图中不易辨认，非法连线拒绝的可读证据以状态栏 ✕ 理由为准；端口特写（局部放大截图）未拍。
2. `page.screenshot` 合成帧滞后（DOM 已更新像素未 paint）是测试基建层面的发现，以「双 rAF + 拍后采样」闭环规避；Chromium 截图管线的底层机制未深究，不影响产品。
3. 产品侧遗留：窄画布（<360px）下 minimap 直接隐藏是最小修复；若产品后续要保留 minimap，需给缩略图开关或响应式缩尺（超出本线路范围，未做）。
4. A 线审计 §五声明项中「W3 点击级行为无法 SSR 验证」已由本线两轮结构探针覆盖；其余声明项维持。
