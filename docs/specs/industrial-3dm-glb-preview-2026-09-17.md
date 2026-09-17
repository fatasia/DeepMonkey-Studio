# 3DM 源网格 → GLB 研究切片

已把上一切片锁定的真实 3DM JSON 网格写入标准 GLB 2.0，并通过产品 `auditGlbGeometry`。只新增研究夹具，没有接入产品依赖或改变格式能力合同。

## 实现

`scripts/fixtures/3dm-glb-export.mts` 复用现有 `@gltf-transform/core@4.4.2` Document/NodeIO 和产品 `createIndexedTrianglePrimitive`，不新增 GLB 编码器。每个源对象网格只建一次，实例递归展开节点、共享 mesh，用节点变换定位；未烘焙或复制顶点。源 buffer 保持局部坐标，根节点统一从 Z-up 转 Y-up 并换算米。

mesh/node/primitive extras 保留源文件 SHA-256、对象 UUID、图层与材质索引及来源。sidecar 保留完整定义成员、引用变换、图层层级、材质身份与缺失诊断。GLB 和 sidecar hash 都绑定在本地 evidence。不能被 glTF-Transform TRS 精确表达的剪切/奇异矩阵明确拒绝，不静默近似。

无缓存 Brep 不生成代理面。没有任何可见网格时返回 `inspect-no-geometry`，不写 GLB；存在旧同名 GLB 时审核脚本报错，避免旧产物混入成功结果。未引用的定义 mesh 不冒充可见场景。

## 真实验证

来源、授权使用边界与原件 SHA 见 [源读取实验](industrial-3dm-source-audit-2026-09-17.md)。本次先校验源 JSON hash 和原始 3DM hash，再导出并调用产品审计，最后逐项比较 GLB BIN 的顶点 Float32 舍入值及完整索引序列，而非只比较数量。

| 样本 | GLB 字节 | 顶点 / 三角形 | 结果 |
|---|---:|---:|---|
| mesh.3dm | 10,220 | 420 / 276 | 产品几何审计通过 |
| meshWithTexture.3dm | 5,120 | 92 / 180 | 产品几何审计通过，纹理未导出 |
| blocks.3dm | 不输出 | 0 / 0 | 1 个缺缓存 Brep 面、3 个不支持对象诊断 |

GLB SHA-256：mesh 为 `17ef5ba4c27cda5877cef45b66c3fe01a6acc05948a6c7fa2e79aeef911fcf52`；meshWithTexture 为 `fdeb279173468af3f769bd95bf9e3eda29a43f6afd22854cdaf1039104b80cd8`。

5 项聚焦测试通过：两次引用共享同一 mesh 且保留不同平移、根单位/坐标变换、未引用定义无伪几何、Brep 缺失诊断、非有限坐标/越界索引拒绝、缺定义/成员/循环/剪切拒绝。实例复用使用合成结构合同测试；真实 blocks 因缺网格没有实例几何显示证据。

```powershell
node --import ./apps/api/node_modules/tsx/dist/loader.mjs --test scripts/fixtures/3dm-glb-export.test.mts
node --import ./apps/api/node_modules/tsx/dist/loader.mjs scripts/fixtures/audit-3dm-glb.mts
```

本地证据 `test-output/3dm-source-audit/glb-evidence.json`，含源 evidence hash、GLB/sidecar hash 和产品审计结果。GLB 与 sidecar 同目录，全部 gitignored。

## 待办与总账合并条目

**已完成**：3DM 固定真实 mesh 源 JSON → 标准 GLB → 产品几何审计及序列化数据逐项对拍；实例共享 mesh 和变换合同测试；缺几何样本保持 inspect。

**本轮待办**：源法线/UV/纹理/PBR 外观、真实带 mesh 的实例样本、外部块依赖、病态/非平面 quad、资源预算与精度、GLB 视觉及 Deep Engine 运行验收。没有 `visual-complete` 或工程验收声明。产品路径不变，总账由主线程合并。
