# outline 效果 × Deep WebGPU 渲染链地雷：最小诚实修复（2026-10-02）

## 雷的机制（③路线登记，主线程核验）

- `apps/web/src/delivery/compileSceneRenderPacket.ts` 把 `model.effects.outline` 透传为实例 `outline: true`（GLB 模型链）。
- `packages/deep-engine/src/renderPacketBatches.ts:66` pack 侧把该标志写进实例 surfaceFlags bit 256。
- `packages/deep-engine/src/webgpu/materialEffectLedger.ts` 的 `consumedValues` 用 `% 1024` 保留低十位语义位（256 在内），作者侧账本值不含该位 → `assertValues` 逐字段比对必抛密码式 `Material effect ledger mismatch for <id>: surfaceFlags.`。
- WGSL 侧零 outline 实现。结果：Web Deep 渲染链遇到描边场景 = 密码崩溃，用户不可操作。

## 关键边界（决定修复位置）

- **Native/WASM 链显式消费该位**：`packages/deep-engine-native/src/gpu_scene.rs:98` `has_outline = row[31] & 256`。outline 透传对 Native 是活功能（产品自带 showcase「机器人 A · 部件拆解与健康」即带 outline，`industrialShowcase.ts:435`）。
- 因此**不得在编译层（compileSceneRenderPacket / sceneSnapshotToRenderPacket / compileLinearPrefabRenderPacket）拦**——首版尝试因 scenePublicationCompatibility 两用例红而撤销（git checkout 恢复，无残留）。
- 发布链已有守卫：`contracts/publicationRendererPolicy.ts` → `selectPublishedRenderer` 的 `preserve-authored-effects`（云 Worker 与发布查看器路径安全）。
- **真实缺口 = 编辑器手动切 Deep**：`initialRendererBackend` 只看 URL/偏好/能力，场景含 outline 时放行 → 撞雷。

## 修复（编辑器切后端入口，与发布链同语义）

- `apps/web/src/hooks/useAppState.ts`：新增 `rendererOutlineRequired` memo（`engine.listModels().some(getModelEffects().outline)`），进返回值（appState 单一事实源；与 `rendererPostProcessingRequired` 注释区分：只拦 outline，后处理域支持面另行演进）。
- `apps/web/src/hooks/useAppRuntimeEffects.ts`：入参类型 + 解构 + 切换 effect 开头守卫——`webgpu && rendererOutlineRequired` → 回落 webgl、`switchPhase=failed`、人话消息（"场景包含描边(outline)效果，Deep 渲染路径尚未支持；已保留 WebGL，关闭描边后可切换"）。依赖数组同步加第 6 项。
- 范围纪律：只拦 `webgpu`；`wasm` 走 native 内核（消费该位），保持现状不扩大边界。

## 验证

- `useAppRuntimeEffects.rendererSwitch.test.ts` 8/8（含新用例：outline 场景拒绝切 Deep、不发起 switchTo、人话消息）；harness deps 过滤同步 5→6 参。
- hooks 域 21 文件 183/183 绿；apps/web tsc 0 错。

## 残留与专批

- 开发者直调 `compileSceneRenderPacket` + `prepareRenderPacket` 的路径仍会撞账本密码错误——引擎 fail-closed 保留，属正确防线；产品用户入口已全部由策略层 + 切换守卫覆盖。
- outline 完整实现（账本收 instance 位 + WGSL outline pass）留引擎专批；此前"时间漂移"归因已纠正为 4f944ce2 同源提交两半自相矛盾（交付半透传 × 引擎半拒收）。
