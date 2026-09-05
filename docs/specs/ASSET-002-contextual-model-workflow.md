# ASSET-002 模型素材上下文闭环

状态：最小链已实现，聚焦通过；生产浏览器门禁待跑，不以代码接线冒充完整验收。

## 范围与事实

场景目录 → 明示“保存并优化/保存并浏览素材” → 项目与源模型定位 → 新优化素材入库 → 项目资源定位新 ID → 返回原场景并新增载入。保存失败必须留在编辑页；原自动保存开关不改变；原模型资源不覆盖、不删除。URL 只接受结构化 project/model/returnScene/returnApplication，不接受任意 redirect。

现有模型 modelId 同时是资源和场景对象身份，loadManifest 同 ID 去重，不支持独立实例身份。deleteModel 会删除项目资源，禁止用它拼接伪替换。替换当前实例本批不开放，需先补引用保持与事务撤销合同。

## 实现路径 / 恢复点

- `appRoute.ts`、`optimizer/modelAssetNavigation.ts`：源 modelId、项目资源 scope、受限场景返回与一次 addModel 意图。
- `ModelOptimizer` / `ModelOptimizerPipeline` / `useModelOptimizerSession`：加载路由指定源模型，入库后新 ID 定位及返回按钮；保留已实现的来源署名、取消和上传回执去重。
- `SceneManager` / `sceneManagerTypes` / `UnifiedAssetLibraryPage` / `ProjectAssetInventory` / `AssetLibraryBrowser`：资源定位与预览/优化入口。
- 场景独立工作流 hook、ModelTreeItem/SceneOutlinerPanel/AppStudioShellView 接线：先保存，返回新增且选中，一笔可撤销；不改仿真/Viewport。

## 尚待验证

23:48 功能最终门禁 `model-asset-context-9SL8Cf/` 暗 1440/亮 980 两组通过，含新增/撤销/重做/重复幂等、原模型状态保留、自动保存仍关闭、真正刷新恢复成功，0 pageerror。人工截图又检出新按钮撑破模型资源行的固定列布局，已改独立 actions 容器与局部栅格，亮色模型标题使用主题文字令牌；正在等待末轮构建后补行内边界/文字对比度断言及最终截图，9SL8Cf 不作为资源行视觉通过证据。

明确仍未达到视觉门槛：小尺寸零件聚焦仍受 `viewerEngineRendering.focusBox` 的半径最小 0.5、距离最小 2m 以及作者 `minDistance/nearClip` 限制；本批新增 focus 调用不等于修好了底层取景。下一优先级是仅显式模型聚焦使用真实尺寸并尊重作者相机边界的实现/测试，禁止更改原模型 scale 或粗改全部场景相机。3D 编辑器亮色仍有旧硬编码浅文字/暗输入，未在本批扩大全站主题改造，也不能据局部对比度声称全页主题已达标。

23:42 补充：真实门禁发现恢复副本误报（撤销/重做触发自己的本地副本恢复弹窗）。已修 `useSceneHistoryActions` / `useAppSceneSyncEffects` 并新增 `workspaceRecoveryDecision` 合同：本会话已写副本按项目/应用/场景/时间戳标识；待决恢复不覆盖；真实刷新 ref 重置仍提供恢复。小尺寸模型新增统一在 `loadModel(!silent && !existed)` 聚焦，静默恢复不抢相机，重复选择不重复历史。相关新增 6 测试通过，最后 typecheck 通过；待主构建复跑两组门禁，不把中途截图算作最终成功。

23:28 恢复点：路由/入口/返回新增接线已完成；`pnpm --filter @bim-studio/web exec tsc --noEmit` 通过。`vitest run src/appRoute.test.ts src/optimizer/modelAssetNavigation.test.ts src/components/AssetLibraryBrowser.test.tsx src/components/SceneOutlinerPanel.test.tsx src/components/ModelOptimizerFields.test.tsx src/components/SceneManagerView.test.tsx src/controllers/sceneOrganizationCommands.test.ts src/studio/sceneAuthoringHistory.test.ts` 8 文件 23 项通过。`gate-model-asset-context.mjs` 已编写且 `node --check` 通过，等待主代理统一构建；将测试暗色 1440 / 亮色 980 的真实保存失败、路由刷新、入库新 ID 定位、返回新增、撤销/重做与重复新增幂等。

聚焦反例（非法返回、无模型、跨项目、保存失败不离开、重复新增）；真实浏览器新增隔离 gate 与截图；主代理统一生产构建。原素材/场景与 admin/admin、存储拓扑禁改，严禁 push；主代理统一 stage/commit。完成后在此回填真实命令、结果和证据，不将计划当成完成。
