# 3DM 原参数到 NURBS 参数映射

日期：2026-09-17。状态：已完成受限参数映射研究切片；trimmed surface 离散与生产 profile 仍为本轮待办。

CAD IR 新增 `parameterMap`：参数一致的实体使用 `identity`，圆弧使用 `arc-angle`，
旋转曲面使用按实际 U/V 顺序排列的 `separable.axes`。未知类型保留 `unsupported`，消费方拒绝求值。
原 `parameterization`、domain 和 trim UV 都保留，未改写拓扑。圆弧合同保存真实角度、参数域和
NURBS 节点分段；消费方用半角正弦比计算每段有理二次参数，随后以独立 Cox–de Boor 求值。
这不是采样插值表；审核样点只作证据，映射可以处理域内任意参数。

读取器复用固定 openNURBS v8.35 的 `ON_ArcCurve` / `ON_RevSurface` 类型信息；原版
`GetNurbFormParameterFromCurveParameter` / `GetNurbFormParameterFromSurfaceParameter` 和
原曲线/曲面 `PointAt` 仅作为独立参考。没有新增依赖或拷贝上游实现。

## 真实样本证据

仍使用既有 rhino3dm v8.32 官方语料及既有来源/使用边界，源哈希见
[CAD IR 记录](industrial-3dm-cad-ir-2026-09-17.md)。两件样本各检查 38 个曲线参数与 252 个曲面参数，
包括端点、接缝与极点；非节点内部样点覆盖参数化差异。

| 样本 | 最大参数残差 | 最大点残差（源单位） | 不映射 UV 的最大点残差 |
| --- | ---: | ---: | ---: |
| blocks.3dm | 4.052e-14 | 7.589e-15 | 0.161688 |
| sphereDecals.3dm | 3.553e-13 | 5.664e-14 | 1.180293 |

两件文件均为毫米单位。球面点残差对应 `5.664e-17 m`。这证明参数点求值一致，
不代表三角离散的弦差、法线、孔洞或闭合性已经通过。

`test-output/3dm-source-audit/parameter-evidence.json` SHA-256：
`be97a0016df451f249fc944416f726f5a10dc2cf0f8dbbeeb298c5eb8528a101`。
审核 EXE SHA-256：`3c826decc77982b22869d362756bbab6be8eb7f826569cddde81b77321e39f37`。
研究 JSON 的求值证据不会写入 GLB，也不改变保存网格的预览状态。

## 复验

```powershell
cmd /c scripts\fixtures\build-3dm-source-audit.cmd
node scripts/fixtures/audit-3dm-source.mjs
node --test scripts/fixtures/3dm-nurbs-parameters.test.mjs
pnpm exec tsx --test scripts/fixtures/3dm-glb-export.test.mts
pnpm gate:repository
```

MSVC 重建通过；上游 `opennurbs_mesh.cpp` 的既有 C4756 警告仍出现。
真实源读取 5/5、参数测试 5/5、GLB 回归 8/8、repository gate 通过。
额外边界覆盖部分圆弧、非零参数域、节点端点、转置轴、未知映射、坏分段、越界及非有限输入。
本片文件 diff-check 通过；全仓 diff-check 仍有其它会话 Unity 配置尾随空格。

下一步消费 `mapSurfaceParameter` 后的参数进行受限 trimmed surface 离散，并分别验证
outer/inner loop、周期接缝、奇点、法线和误差预算。非圆弧参数化 2、任意复合曲线和一般曲面
映射继续保持 unsupported；没有提升生产能力声明。工程自检十项均为 9/10。
