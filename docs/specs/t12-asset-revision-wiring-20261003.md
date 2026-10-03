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
