# T12 资产修订与再导入编辑器接线（2026-10-03）

## 现状核查

### 1. 全仓 grep 任务关键词与相关 UI

- `detectStaleAssetRevisions` 只在 `apps/web/src/viewer/assetRevisionSnapshot.ts` 定义并由同名测试覆盖，生产 UI 零调用。
- `DeepAssetReimportCoordinator` 只在 `packages/deep-engine/src/assetReimportCoordinator.ts` 定义、测试，并由 `packages/deep-engine/src/index.ts` 导出，`apps/*` 零消费。
- `assetDeletionImpact` 已有 `apps/web/src/delivery/assetDeletionImpact.ts` 与测试，但 `SceneManager.tsx` 删除确认仍只展示治理计数。
- 相关 UI 已存在：`ProjectAssetInventory.tsx` 负责资源卡片与删除入口，`SceneManager.tsx` 负责模型/媒体删除确认，`SceneResourceBrowser.tsx` 是编辑器资源面板，`FlatSceneObjectList.tsx`/`SceneOutlinerPanel.tsx` 是场景对象列表。未跟踪文件中已有 `assetDeletionImpact.ts`，本次只接线不重写能力。

### 2. 契约层与 deep-engine 类型

- `packages/contracts/src/scene.ts` 已有 `SceneModelState.assetRevision` / `SceneAssetRevisionSnapshot`，字段为 `packageId`、`revision`、`sourceHash`。
- `packages/contracts/src/project.ts` 已有 `ModelManifest.deepAssetPackage` / `DeepAssetPackageReference`，字段为 `packageId`、`revision`、`sourceHash`、`entryScene`、`packageUrl`。
- `packages/contracts/src/sceneModelAsset.ts` 已有 `getSceneModelAssetId`，说明实例身份与资源身份分离。
- `packages/deep-engine/src/assetReimportCoordinatorTypes.ts` 已有协调器 Adapter/Result 合同；`assetReimportCoordinator.ts` 已实现并发、CAS、回滚、释放与状态归一。

### 3. 依赖核查

- `apps/web/package.json` 已依赖 `@bim-studio/deep-engine`、`@bim-studio/contracts`、`lucide-react`、React/Vitest；无需新增依赖。
- 根 `package.json` 与相关包脚本已有 `typecheck`、`test`；本任务使用定向 Vitest 与 `tsc --noEmit`。

### 4. 消费方核查

- `captureSceneModelState.ts` 已在保存/替换实例时写入 `assetRevision`。
- `useSceneModelInstances.ts` 已有实例替换链，但它面向当前打开场景；本次资产库接线更新已保存场景快照中的修订引用，不改高频渲染循环。
- API 已有 `api.saveScene`、`api.listScenes`、`api.deleteModel`、`api.deleteAsset`、`api.getProject`；`deep-package.json` 当前只暴露最新包 manifest，没有按旧 revision 读取的后端端点。

### 5. 测试与证据

- 已有 `assetRevisionSnapshot.test.ts` 覆盖陈旧检测纯逻辑。
- 已有 `assetDeletionImpact.test.ts` 覆盖字段路径级引用影响。
- 相邻组件测试多用 `renderToStaticMarkup` 或 mock React hooks 后直接遍历 React element；本次沿用该风格补资产卡片提示、更新入口、失败反馈与删除影响确认测试。

### 6. 规格文档核查

- `docs/specs/t12-scope-lock-20261002.md` 更正：删除引用影响计数级生产实现已存在，路径级 helper 已就绪但 UI 接线待做。
- `docs/specs/t-audit-batch1-20261001.md` 明确 `T12-asset-revision-ui` 与 `T12-reimport-editor-link` 仍缺生产消费。
- `docs/specs/omission-audit-20261004.md` §2.1 A 表第 1、2 行确认两项零消费；`docs/specs/handoff-remaining-tasks-20261004.md` §三第 3 项把 `assetDeletionImpact`、`detectStaleAssetRevisions`、`DeepAssetReimportCoordinator` 归为 T12 交付悬空族。

### 已有（不重建）

- 陈旧检测纯函数、资产删除影响纯函数、场景/项目资产修订合同、深度资产再导入协调器、项目资源治理计数、保存场景 API 与资源删除 API。

### 真实缺口

1. 资产库/编辑器资源面板没有把 `detectStaleAssetRevisions` 的结果 memo 后展示为克制提示。
2. 用户没有可点击的“一键更新”入口；更新过程没有即时状态、成功反馈、失败重试。
3. `DeepAssetReimportCoordinator` 没有浏览器侧消费；由于旧 revision 包读取端点缺失，本次只能用当前包 + 场景旧修订快照构造场景侧 CAS/再导入验证，再更新场景快照修订引用。
4. 删除模型/媒体资源前没有展示 `assetDeletionImpact` 的字段路径级影响清单。


## 实施结果（2026-10-03）

### 现状核查补充
- 先前会话已完成：`SceneManager` 接线 `detectStaleAssetRevisions`（memo）、`updateAssetRevision`（`runAssetRevisionReimport` → `DeepAssetReimportCoordinator` 场景侧 CAS → `applyAssetRevisionToScenes` → `api.saveScene`）、`onAssetRevisionScenesUpdated`（`AppPlatformRoutes` 回写 scenes）、删除确认接入 `computeAssetDeletionImpact`；`AssetRevisionInlineNotice` 定义在 `ProjectAssetInventory.tsx`（测试从该文件导入，无需独立文件）。
- 本次真实缺口：①缺"保持当前"；②无卡片级"已陈旧"徽标；③窄卡片(256px)内提示被挤成竖排、说明被截断；④默认 JSON 解析失败直接暴露 `Unexpected token '<'`；⑤删除确认在"治理计数为 0 但路径级影响>0"时仍写"未引用"，与影响清单自相矛盾；⑥info 态标题仍写"陈旧"。

### 改动
- `components/ProjectAssetInventory.tsx`：`AssetRevisionInlineNotice` 新增 `onKeep`，按钮"更新到最新版本 / 保持当前"，更新中显示"更新中…"+`aria-busy`；info 态标题"正在更新修订"；卡片状态行新增"⚠ 已陈旧"徽标（图标+警示色+文字，title 含 rN→rM）。
- `components/ProjectAssetInventory.css`：提示改两行布局（说明自动换行，操作行独立）；入场 240ms expo.out、hover/focus-visible（`--accent`）、`prefers-reduced-motion` 关闭动画；徽标与按钮仅用 `--warning/--success/--danger/--info/--line/--text-muted/--accent` 令牌。
- `components/SceneManager.tsx`：新增 `keptAssetRevisions`（按 `assetId@latestRevision` 会话内忽略，更高修订再次出现会重新提示）与 `keepAssetRevision`；删除确认（模型/媒体）用 `usage.instanceCount || impact.totalReferences` 作引用数，措辞与影响清单一致。
- `delivery/assetRevisionUpdate.ts`：默认加载器 JSON 解析失败时给出可读错误。
- 测试：`AssetRevisionInlineNotice.test.tsx` +2（保持当前/忙碌禁用）、`SceneManagerAssetDeletion.test.tsx` 增加措辞断言。

### 验证
- vitest（assetDeletionImpact / assetRevisionUpdate / assetRevisionSnapshot / AssetRevisionInlineNotice / SceneManagerAssetDeletion）5 文件 15 用例全过。
- `tsc --noEmit`：本任务文件无错误；全量出现他人未提交文件 `components/ParticleCurveEditor.tsx(127,24) onBackgroundDoubleClick` 错误（非本任务范围，未触碰）。
- 浏览器（1920×1080 深色，Playwright 路由注入 manifest r3 + 场景快照 r1，真实 UI 流程）：徽标/提示渲染、点击更新→忙碌态→成功"已更新 2 个实例，影响 2 个场景"（PUT 两个场景）、失败态显示错误+"重试更新"、"保持当前"后提示消失、删除确认含"影响范围：共 2 处引用 - 场景名: models[0].assetModelId"。证据：`test-output/t12/{d-card,e-busy,e-after,f-*,g-*}.png` 与 `shot.mjs`。

### 遗留
- 后端无按旧 revision 取包端点：协调器用"当前包 + 场景旧修订快照"做场景侧 CAS，未做真实旧包 diff。
- "保持当前"仅会话内生效，未持久化；删除确认沿用项目通用 `window.confirm`（未做自绘对话框）。
