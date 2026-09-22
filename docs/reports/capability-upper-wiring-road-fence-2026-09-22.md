# 道路/围栏上层接线审计（2026-09-22）

## 结论

道路与围栏已经从 capability catalog、Inspector 的 `placementPath` 编辑器接到 `sceneSnapshotToRenderPacket` / `compileSceneRenderPacket`。真实断链位于发布兼容审计：`collectDeferredObjectFields` 没有把对象的 `prefab` 字段列入已消费字段，因此合法道路/围栏会被误报为 `deep.scene.uncompiled.v1`。

## 改动

- 在 `apps/web/src/delivery/sceneInactiveFields.ts` 将 `prefab` 纳入 `projectedObjectFields`，使发布兼容审计与 RenderPacket 编译器对齐。
- 在 `scenePublicationCompatibility.test.ts` 增加带两点 `road.straight` 铺设路径的回归测试，确认不会生成 `objects["road"].prefab` 未编译阻断项。

## 验证

`pnpm exec vitest run apps/web/src/delivery/scenePublicationCompatibility.test.ts`：17 tests passed。

未运行全量测试；工作区存在其他并行修改和既有类型检查噪声。
