# 3DM B-Rep 保存网格预览与部分几何标记

日期：2026-09-17。范围仍为 openNURBS 研究预览，不提升 3DM 生产 profile。

本片读取 3DM 内实际保存的 `ON_BrepFace::Mesh(ON::render_mesh)`，按源 face 分 primitive 写入
GLB；不调用商业 Rhino SDK，不把 openNURBS 的文件读取能力冒充 B-Rep 离散器。源文件没有保存
render mesh 时继续输出诊断，不生成替代几何。

## 实际样本

新增两份 rhino3dm v8.32 官方样本，均在读取前后复核 SHA-256，并由原版 openNURBS reader
和本地 `/Brepro` 审计程序重复读取：

| 文件 | 源 SHA-256 | 实际结果 |
|---|---|---|
| `sphereDecals.3dm` | `2f4f218e2b5952da1ba280ae4db4ec5a08947c9f5b012d4194be9171eebccc93` | 1 个 B-Rep/1 个已保存 face mesh；9,895 顶点、18,752 三角、9,895 法线与 UV |
| `file3dm_stuff.3dm` | `e78ca005c86130953a5b4c0c44d068ae1d00665f4c0f6028edd3911a01d4ff88` | 5 个 B-Rep 共 13 面，仅 1 面有保存网格；4 顶点、2 三角，另外 12 面明确缺失；另含 1 定义/2 引用 |

`sphereDecals` 输出 543,784-byte GLB，SHA-256
`0d0686975af493f2fa883fb59dd41afd3e070d8fd6798f29b28a575840564cbc`；产品几何审核为
1 mesh / 1 primitive / 9,895 vertices / 18,752 triangles。`file3dm_stuff` 输出 11,776-byte
GLB，SHA-256 `2208bc8b702e223c4031ff6c0beba0d3fb9aa06e96693b51a0af4f98fea268cd`，只包含可证明的
1 个 face mesh。

## 失败关闭

- sidecar 状态新增 `partial-geometry-preview`：只要可见 GLB 中仍有 B-Rep face 缺少保存网格，
  就不能报告完整 `geometry-preview`。全无几何仍为 `inspect-no-geometry`。
- 每个 primitive 保留源 object 与 `brepFaceIndex`；位置、索引、法线、UV 从 GLB BIN 独立逐项
  对拍，不能只比计数或 extras。
- 源材质/纹理路径仍仅作身份元数据，不生成 image/texture/PBR 外观；两个新样本没有提供可分发
  贴图字节，不能从文件名或查看器覆盖猜测。
- 定义与引用身份保留，但 `file3dm_stuff` 的定义成员本身没有保存 mesh；两个引用不会制造可见
  代理几何。

## 验证

- openNURBS 真实源审计：5/5 样本读取、重复字节、截断/缺失反例通过。
- GLB adapter：8/8；新增测试同时证明部分/完整 B-Rep 状态不可混淆。
- 5 份实际输出全部经过产品 `auditGlbGeometry`，Float32/UInt32/NORMAL/TEXCOORD_0 与源值逐项一致。
- `evidence.json` SHA-256：`70c8d2aac67b439dcfebeb109312f949211d96eb651e4130edb4805562f90745`；
  `glb-evidence.json` SHA-256：`3e5cb6d52c31bee7fb39a4bafecd58c2dfa153c24f984b9e61b7f0a97fd94078`。

## 边界与下一入口

这证明保存网格的读取、face 归属和大网格导出，不证明无缓存 B-Rep 的离散。下一步仍须把
openNURBS curve/surface/trim 拓扑映射到自研 CAD IR，再由自研 tessellator 生成网格；不得引入
Rhino、Open Design Alliance 或其他商业 SDK/转换器。完整 decal/user-data、WCS/PBR、嵌套实例
可见网格和 Deep Engine 运行验收仍待办。
