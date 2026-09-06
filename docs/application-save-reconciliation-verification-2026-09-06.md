# 三维保存回声与二维场景一致性（2026-09-06）

## 真实问题

`scene-shell-theme-5i6Oii` 的四组真实浏览器中，3D → 2D 已能导航，嵌入视口也 ready，但画布只有网格。隔离数据库逐组核实：后端应用中的场景有 1 个模型，二维节点引用的 sceneId 正确；不是模型文件被删或场景引用丢失。

根因在 `ApplicationStore.acknowledgeSave`：三维引擎状态经 `syncSceneIntoApplication` 合入请求载荷，但原 Store 文档仍是旧场景。旧回声逻辑比较当前文档与服务端文档，只要不相同就当作“保存期间的新编辑”，仅接收元数据，始终留下空场景。此时二维仍显示旧文档，后续保存甚至可能重新送出旧状态。

## 已完成

- `acknowledgeSave(saved, baseline?)` 增加可选明确基线；调用者须在扩充三维请求载荷前取得 Store 文档。未传基线的既有调用继续保留原回声语义。
- 以 current / baseline / saved 做三方合并：未改的字段接收服务端回声，同字段竞争保留后续本地编辑；具有唯一 id / modelId 的对象集合按身份合并，不凭索引匹配模型；无身份数组冲突保留本地。
- 本地删除不被服务端回声复活，未发生本地编辑的服务端删除可正常接收；二维页面、脚本与场景可以独立合并。
- undo / redo 快照同步合入外部保存变化，避免下一次撤销二维标题时又丢掉刚导入的模型；不伪造新撤销命令，不重置选择、运行变量或筛选条件。
- 不接收其它 application / project 的迟到响应，也不让旧 revision 回退当前文档。
- 实现：`packages/studio-core/src/applicationSaveMerge.ts`、`applicationStore.ts`、`apps/web/src/studio/applicationSession.ts`。根任务负责 `saveScene` 的实时基线取值和调用接线。
- Core 全量 **12 文件 / 79 项通过**；其中最初新保存合并与既有 Store 聚焦 **2 文件 / 33 项**，追加历史反例后纳入全量，core typecheck 通过。Web Session + sceneApplicationSync 聚焦 **2 文件 / 9 项通过**。

新增 10 项（Core 9 + Session 1）覆盖：冻结快照外部模型、请求期间二维/脚本变化、撤销/重做保模型、同模型字段竞争、新增模型与双向删除、无身份数组冲突及本地顺序、跨文档/项目/旧版本、空 Store 迟到请求、Session 基线透传，以及历史场景旧透明度/旧二维标题不被新缩略图和新增模型过度覆盖。输入文档不被直接修改，输出仍由 Store 深冻结。

根调用层已接线：`saveScene` 在快照前取实时 Store 基线，送出载荷不用旧 React activeApplication；响应以此基线回填。场景版本变更或切项目后不把名称/目录/自动保存revision拉回旧场景。`AppWorkspaceTopbar` 统一等待此事务再返回二维，失败留页、重复离开去重；原 `applicationRuntimeController` 不再直接修改冻结场景的 thumbnail。聚焦 `sceneWorkspaceSave` 4项覆盖最新闭包、并发二维编辑/撤销仍保模型、写失败保副本、跨项目迟到成功不改新工作区；连同 Topbar、运行控制器、Session/sync 共5文件20项通过。

根任务 r5 生产构建后，两轮 `gate-scene-shell-theme.mjs` 均通过：默认品牌 `scene-shell-theme-x0ofFb`、紫色品牌 `scene-shell-theme-6NeHy5`，每轮双主题 × 1280/980 共四组。真实 UI 登录、创建场景、导入已审核夹爪、保存成功反馈后，比较后台 API 完整 models 数组 → 二维嵌入视口 ready / 正确 sceneId 引用 / 1 个场景对象 → 回三维已加载模型 → 再次 API 完整数组一致。八组均不需要键盘重试或刷新恢复，0 产品控制台错误。

人工查看两轮的浅色 980 二维/三维画面，实际夹爪存在，不只凭 DOM 标签认定。原 GLB 保持 277392 字节，SHA-256 `a46d98dc70a98e3d7d35fc0d78c089588bf292b0878b54b340afb1e2da8581c8`；未重缩放或改模型几何。已失败的 `scene-shell-theme-5i6Oii` 保留原结论，不能改写成通过。

共享品牌焦点修复进入 r6 后，相邻最终复跑 `scene-shell-theme-ulm3QR`（默认）与 `scene-shell-theme-ScDsCs`（紫色）各四组仍全部通过；人工亲审浅色 980 二维夹爪及暗色 980 三维返回，API 完整 models 数组、正确引用和源 GLB 哈希断言均保持。0 产品控制台错误，每轮首组既有 ANGLE X4122 驱动诊断单列；隔离服务与浏览器已关闭。主题仍有未覆盖缺口，见 `scene-shell-quality-verification-2026-09-06.md`，不影响本数据一致性修复结论。

## 本轮待办

本保存一致性缺陷已完成上述固定夹具闭环和最终相邻复查，无本缺陷源码待办；项目级复杂并发边界见下文，整体工作台尚欠的主题与布局由对应队列继续。

## 明确排除

不修改真实项目数据、账号、数据库或对象存储配置；不通过 reload 或清缓存掩盖状态问题。未把此实现扩成多用户离线协作或任意 JSON 冲突解决产品。

## 项目级后验收

模型/场景复杂并发与长期历史规模仍需项目级矩阵；当前的冲突策略明确偏向保留本地后续编辑，不承诺无身份数组的自动逐元素合并。使用本地已有能力，不新增依赖。
