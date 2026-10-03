# J3-E 编辑器域恢复聚焦 CPU 回归（2026-10-01）

## 现状核查

1. 全仓检索 recovery/rendererSnapshot/capture/restore，检查未跟踪项。DeviceSession、Three桥、致命丢失回退、RendererRecoveryState和ScenePersistenceController均已存在；冻结期间不改生产源/Native/src。
2. 已读SceneSnapshot、CameraState、SceneEnvironmentState、RendererRecoveryState与控制器依赖类型。21域中的现场camera、命名默认cameraViews、动画策略/瞬时播放头、环境keptMips、selectionSets/rootLayerOrder都有既有载体，不新增持久化协议。
3. web/package.json 已用Three/React/Vitest/TypeScript；使用既有工具和实际controller/capture函数，不需新依赖/状态机。
4. 消费方：onRendererDeviceLost→rendererSnapshotRef→runtime effect→applyScene；同ref另有WebGPU回收/返回编辑器producer。makeSnapshot→makeSceneSnapshot实际采集引擎+React作者域。ViewSnapshotReadiness已有代际门。P1会话内unknown恢复与P2致命回退不同，不能以P2 CPU检查认证P1 GPU。
5. 已查sceneRendererRecoveryPlayhead、sceneSnapshotFactory、sceneWorkspaceSave、runtime rendererSwitch、Play restore/readiness测试。已有播放头测只验calledWith(playhead)，未断言最后UI值；已有restore失败传播属于Play path的requireComplete=true，P2 consumer实际传false。
6. 已读j3-e-editor-state-cpu、j3-e-gpu-runner-prep的21域tier、window recovery、remaining、handoff/ledger。当前3-5域回归不改21域全量完成状态；actual unknown driver fault仍未证。

已有（不重建）：完整applyScene、真实现场snapshot工厂、播放头协议、Readiness代际、失败requireComplete传播、默认视图载体、环境mip carrier、目录组织载体。

已复现真实缺口：P2现场相机被默认命名视图覆盖；seek到播放头后末尾UI time又归0；P2传requireComplete=false导致restore吞加载错并在consumer后续宣布成功。实际函数CPU执行已确认。另以环境keptMips与目录层序两个作者域做真实capture→restore正向合同。

## 冻结与验证边界

所有测试/修复稿在ignored本目录；仅执行真实makeSceneSnapshot/createScenePersistenceController/ViewerSnapshotReadiness与CPU作者载体函数，不构造GPU device，不声称真实GPU恢复。root 解锁后已落 scenePersistenceController.ts、runtime 恢复 consumer 与独立小 helper/测试。

## 修复与合同

- renderer recovery 专用 helper 复用 applyScene，以 requireComplete=true 和第10参 restoreLiveCamera=true 还原现场相机；普通路由仍使用作者默认命名视图。
- applyScene 在恢复 seek 后读取真实 animation transient channel，最终 UI 值与引擎一致；覆盖12.5秒、被引擎限制到5秒两例。缺省/非法恢复播放头仍归零，动画播放策略保持暂停。
- P2恢复加载失败传播到实际 useAppRuntimeEffects，phase=failed、没有成功/activeBackend提交；旧 snapshot 保留并由同一effect实际重试成功。失败回调不覆盖更新的 pending snapshot。
- Strict readOnly recovery 同步等待所有模型；普通只读路由（requireComplete=false）仍首模型加载后后台分段。第二模型失败不提交 ready/activeScene。
- 环境 environmentSpecularMips=4 与目录 selectionSets/rootLayerOrder 用真实 makeSceneSnapshot→applyScene 往返验证；没有新增持久化字段或状态机。

## 验证

证据目录 `test-output/j3-e-editor-domain-20261001/` 为本地 ignored。

| 范围 | 结果 | 证据 |
|---|---|---|
| 已知原行为 CPU 基线（11例） | 7失败/4通过 | before-verified.txt、before-known-fixes.config.mjs |
| 新5域/strict只读/实际consumer矩阵 | 11/11通过 | final-regression.txt |
| 相关10文件总回归 | 75/75通过，exit0 | final-regression.txt |
| 完整Web TypeScript | exit0 | final-web-tsc.txt |
| 引擎source-size gate | 2922文件、175既有警告、0失败，exit0 | source-size.txt |

原行为基线通过 Vite 内存 transform，仅将 helper 参数恢复为原 consumer 的 requireComplete=false/未选现场camera、动画末尾 UI=0、失败不留snapshot。生产源没有为基线回退。新的consumer harness选取依赖为单engine且具 getRendererBackend 的实际effect，避开单 studioPublishOpen 依赖effect；早期草稿harness误选产生的失败不作为完成依据。基线最终明确复现phase=idle误报。

执行：

```powershell
pnpm --filter @bim-studio/web exec vitest run src/controllers/sceneRendererRecoveryDomains.test.ts src/hooks/useAppRuntimeEffects.rendererRecovery.test.ts src/controllers/sceneRendererRecoveryPlayhead.test.ts src/controllers/sceneWorkspaceSave.test.ts src/controllers/sceneSnapshotFactory.test.ts src/hooks/useAppRuntimeEffects.rendererSwitch.test.ts src/hooks/useAppNavigationController.test.ts src/controllers/playSessionRestore.test.ts src/controllers/playSessionRestoreTiming.test.ts src/hooks/useScenePlayMode.test.ts --maxWorkers=1
pnpm --filter @bim-studio/web exec tsc --noEmit
```

## 冻结与剩余

六个本轮源/测试hash见同目录 frozen-source-hashes.json。仅Web app源变动，Native/engine/contracts未动；不需要因此重建WASM，后续当前源码window/normal收据由root串行更新。

这里覆盖5个编辑域的P2 CPU合同：现场camera/default views、animation playhead、scene identity/readiness、environment mip carrier、目录分组/层序。执行实际capture/controller/readiness/carrier/hook；模型下载、ViewerEngine和React调度由CPU fixture提供。它不认证真实GPU恢复、P1 session unknown驱动故障、21域全覆盖、GPU presented timing或物理HDR显示。动画停止/引擎clock具体GPU/真实editor状态仍由root实际浏览器/恢复矩阵验收。