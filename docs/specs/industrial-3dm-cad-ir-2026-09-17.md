# 3DM trimmed NURBS CAD IR

日期：2026-09-17。范围仍为 openNURBS 研究读取，不提升 3DM 生产 profile，也不把 CAD IR
误报为已离散的几何预览。

本片把 `ON_Brep` 的顶点、3D edge curve、2D trim curve、surface、edge、trim、loop 和 face
写入版本化 `trimmed-nurbs-brep` CAD IR。曲线和曲面统一为 NURBS form，将 openNURBS 省略的首尾 knot
按相邻端值补齐并显式标记约定，同时记录次数、控制点、权重编码、闭合/周期性、proxy subdomain、
curve/face 朝向、可用 tolerance 及全部拓扑引用。读取时先验证 openNURBS B-Rep，
输出后再由独立 Node 门禁复核数组长度、有限值、knot 单调性、domain、引用闭包和 face 分母。

## 真实样本证据

样本均来自 rhino3dm v8.32 官方仓库，源 SHA-256 与上一片保持不变：

| 文件 | 源 SHA-256 | CAD IR 结果 |
|---|---|---|
| `blocks.3dm` | `1e428317489c7c22ee68fb93e119079c718a0ba44efa7c89efb10cf0d8491cb8` | 1 face；2 vertices / 1 edge / 4 trims / 1 loop / 1 surface |
| `sphereDecals.3dm` | `2f4f218e2b5952da1ba280ae4db4ec5a08947c9f5b012d4194be9171eebccc93` | 1 face；拓扑分母同 `blocks`，同时继续保留 18,752 个缓存三角形 |
| `file3dm_stuff.3dm` | `e78ca005c86130953a5b4c0c44d068ae1d00665f4c0f6028edd3911a01d4ff88` | 5 B-Rep / 13 faces；32 vertices / 42 edges / 52 trims / 13 loops / 13 surfaces |

五件固定样本都由原版 openNURBS reader 和确定性审核程序重复读取；截断文件和不存在文件继续失败且
不输出部分 JSON。CAD IR 输出哈希：`blocks` 为
`7574748cc556b9265bb527a092feb8404a8697c750a76f0a7b6e55ea465aa15f`，`sphereDecals` 为
`0ca9cdecd24ce388f8a3f201af03450bfe52fe4f251cf275957d737a00f2652d`，`file3dm_stuff` 为
`d912b82c239e69ac12dca1e9f5b02e66fb353bf3b89078b1ce87b87006fd473c`。完整 `evidence.json`
SHA-256 为 `5a1e6b1f6d62884690aefb75887f31caf7425ca1de62c02e8cada0c4125bde99`。

## 参数化边界

`file3dm_stuff` 的 107 个曲线/曲面 NURBS form 全部返回 parameterization `1`，可保持参数一致。
球面样本的六个曲线/曲面实体中四个为 `1`、两个为 `2`。`2` 只证明 NURBS 点集与 domain 一致，
不证明原 surface/curve 参数与 NURBS 参数逐点一致；IR 保留该标志，后续离散桥必须实现并验证参数映射，
不得直接把 trim UV 套到转换后的 surface 后声称精确。

## 验证与剩余边界

- MSVC v143 从官方 openNURBS v8.35 原版源码零补丁重建审核程序，EXE SHA-256
  `17323b75541068e361e5752eb492dc3a177d4b1ce16bf5d4aa233d2bb4f641dc`。
- `node scripts/fixtures/audit-3dm-source.mjs` 通过 5/5 真实样本、重复确定性、拓扑/NURBS 合同和失败输入门禁。
- 保存网格的 GLB 行为未修改；没有保存网格的面仍保持 `inspect-no-geometry` 或
  `partial-geometry-preview`，没有生成代理三角形。

下一步是消费 CAD IR 的受限离散器：先覆盖 parameterization `1` 的平面/双线性面及 outer/inner trim，
再为 parameterization `2` 建立原参数到 NURBS 参数的真实映射和误差证据。SubD、插件对象、任意 NURBS
精度、闭合性及生产接线仍未完成。
