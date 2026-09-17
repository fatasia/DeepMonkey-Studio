# DE26/B02 SceneChangeset → Three 脏域切片（2026-09-17）

## 状态

B01 的权威变化集已接到 Three 投影前置脏域规划：节点绑定显式、父节点变化包含完整后代、
迟到计划不能确认、缺绑定与删除强制 full fallback。B02 整卡仍待真正的缓存对象投影与 GPU
实例更新消费，不标记完成。

## 合同与实际链路

- `SceneChangesetProjection` 只消费 `applySceneChangeset` 的 applied outcome；rejected outcome 不产生脏域。
- nodeId→Three object 是显式一对一绑定，重复 node/object、无效对象、环和重复 child 全部 fail-closed。
- `changedNodeIds` 映射节点级对象；父 transform/hidden 会收集完整后代，避免祖先变化漏掉 world matrix 或可见性。
- `removedNodeIds`、缺绑定或非字符串图 ID 不猜映射，明确请求 full fallback。
- 每份计划带单调 token；后来的计划会使旧 acknowledge 失败，避免迟到投影覆盖当前 revision。
- 指标记录绑定数、源命令数、脏节点/对象数、dirty ratio 与 fallback 原因；100 叶节点夹具单叶变化为 1/101，不把未变 sibling 放入脏域。

本片没有建立第二套场景状态，也没有扫描几何/材质。`SceneTransformGraph` 仍是唯一权威，
下一片由 `ThreeProjectionBridge` 用此 dirty plan 复用已接受对象缓存，并与 full packet 对拍。

## 验证

```text
pnpm --filter @bim-studio/deep-engine exec vitest run \
  src/threeBridge/SceneChangesetProjection.test.ts \
  src/scene/SceneChangeset.test.ts \
  src/threeBridge/ThreeProjectionBridge.test.ts
  3 files, 28 passed
pnpm --filter @bim-studio/deep-engine typecheck
  passed (core + lab)
git diff --check -- <B02 files>
  passed
```

## 视觉边界

本片是纯投影合同，不改 RenderPacket、shader、材质、相机、灯光、CSS 或最终像素；Kimi-95
视觉闭环不适用。后续真正切换 Bridge 增量消费时，必须补 full/incremental packet 对拍、真实
浏览器 GPU 两轮像素/截图与 10 维度评分。
