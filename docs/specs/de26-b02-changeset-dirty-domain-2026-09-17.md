# DE26/B02 SceneChangeset → Three 脏域切片（2026-09-17）

## 状态

B01 的权威变化集已接到 `ThreeProjectionBridge.projectDirty`：节点绑定显式、父节点变化包含完整后代、
迟到计划不能确认、缺绑定与删除强制 full fallback。桥内已复用最近 acknowledge 的对象片段、几何、
材质和纹理缓存；B02 整卡仍待 Studio/Web 宿主消费与真实 GPU 数据，不标记完成。

## 合同与实际链路

- `SceneChangesetProjection` 只消费 `applySceneChangeset` 的 applied outcome；rejected outcome 不产生脏域。
- nodeId→Three object 是显式一对一绑定，重复 node/object、无效对象、环和重复 child 全部 fail-closed。
- `changedNodeIds` 映射节点级对象；父 transform/hidden 会收集完整后代，避免祖先变化漏掉 world matrix 或可见性。
- `removedNodeIds`、缺绑定或非字符串图 ID 不猜映射，明确请求 full fallback。
- 每份计划带单调 token；后来的计划会使旧 acknowledge 失败，避免迟到投影覆盖当前 revision。
- 指标记录绑定数、源命令数、脏节点/对象数、dirty ratio 与 fallback 原因；100 叶节点夹具单叶变化为 1/101，不把未变 sibling 放入脏域。

`projectDirty` 只重投 dirty roots，按原拓扑顺序拼回未变 instance，并从当前引用裁剪几何、材质和纹理；
共享材质变化会更新完整 packet 中的同 ID 材质，未变 sibling instance 保持对象身份。删除、缺绑定、
root/camera mask 不同、拓扑未知和当前 deformation/author LOD 能力会走既有 `project()` 全量路径。
增量结果与 dirty plan 共用一次 acknowledge，迟到计划不会进入 bridge accepted cache。

本片没有建立第二套可编辑场景状态；`SceneTransformGraph` 仍是唯一权威，桥缓存仅保存可重建渲染快照。

## 验证

```text
pnpm --filter @bim-studio/deep-engine exec vitest run src/threeBridge
  21 files, 218 passed
pnpm --filter @bim-studio/deep-engine typecheck
  passed (core + lab)
pnpm --filter @bim-studio/deep-engine benchmark:three-incremental
  Node v24.18.1 / i9-12900HX / 100 leaves / 7 warmups / 31 alternating samples
  incremental p50 1.996 ms, p95 4.329 ms
  full        p50 2.809 ms, p95 7.567 ms
  source objects rebuilt 101→1; newly allocated RenderInstance snapshots 100→1
pnpm --filter @bim-studio/deep-engine gate:source-size
  changed ThreeProjectionBridge.ts = 300 lines; no new violation
  repository gate remains blocked by 14 pre-existing files above 300 lines
git diff --check -- <B02 files>
  passed
```

## 视觉边界

本片新增可选的 packet 生成路径，但未切换 Studio/Web 宿主，不改当前浏览器最终像素；Kimi-95 截图
闭环仍不适用。渲染风险由 transform、父隐藏、父子重叠、共享材质、独立纹理、删除和缺绑定场景的
incremental/full `RenderPacket` 逐项等价覆盖。宿主真正切换时必须补真实浏览器 GPU 两轮截图与 10 维度评分。
