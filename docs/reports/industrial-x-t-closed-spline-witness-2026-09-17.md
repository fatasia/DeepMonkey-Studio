# X_T 闭合样条边界独立见证

6 个缺少源见证的面已补齐边界审核。相同 109 件 GLB、相同源文件和 `0.01 mm` 预算，结果由 `19337 matched / 1 mismatch / 6 unresolved` 变为 **`19343 matched / 1 mismatch / 0 unresolved`**，没有状态回退。生产 profile 仍为 0。

## 缺口与实现

这 6 面的源支撑为 SWEPT_SURF，每面由两个无顶点、单 FIN 自闭合环围成，直接边曲线为 B_CURVE → NURBS_CURVE。已有转换器可以输出这些几何，缺的是独立 oracle 的样条边界见证，不是导入解析丢面。

新增 [xt-closed-spline-witness.rs](../../scripts/fixtures/xt-closed-spline-witness.rs) 从原始控制点、节点值和重数求值，不链接 cad-ir、cad-xt 或转换器求值函数。采用 Cox 基函数求和，与转换器的 de Boor 求值路径分离。每个非零节点区间采样 8 点，并保留末端点，源米坐标换算为毫米。

合同限定为：直接 B_CURVE、三维非有理、源声明 closed、两端夹持、次数 1–8、控制点端点闭合；维数、重数、节点顺序、有限数值和资源上限逐项检查。TRIMMED、多边环、未夹持、有理及开放样条不被扩成完整闭合曲线。无效或尚未支持的定义不补造见证。

## 6 个面

| 模型 / body / face | 源边界见证数 | 最大边界差（mm） |
|---|---:|---:|
| A,AS-1310L / 12 / 2957 | 192 | 0.0049415285 |
| A,AS-1310L / 12 / 2962 | 128 | 0.0024782739 |
| A,AS-1310R / 7 / 3826 | 128 | 0.0024783980 |
| A,AS-1310R / 7 / 3824 | 192 | 0.0049414476 |
| AA-0222B / 24 / 1809 | 160 | 0.0023297816 |
| AA-0222B / 24 / 1807 | 96 | 0.0023684991 |

同族扩展共覆盖 15 个面、新增 1792 个边界点。12 个几何重合见证仍显式记录为 repeatedWitnessFaces；几何匹配不证明唯一身份。上述 6 面的 `surfaceKind` 仍为 null：本片证明采样边界匹配，不证明扫掠面内部全域、拓扑完整性或生产可用性。

AS, AT-2810R body 24 face 360 仍有 `0.0441604055 mm` 交线支撑差。既有源域诊断继续有效，不能将有限域不相容直接解释为整个源文件损坏。最后单面的深层映射诊断与其余真实模型导入主流程分别推进。

## 验证与证据

- 3 个新增数学测试：三次基函数对 Bernstein 已知值、非均匀节点区间端点、开放/非有限/未夹持/逆序及非法节点拒绝；首次浮点精确相等断言改为 `1e-12` 数值比较后通过。完整 oracle 数学测试 5/5，Node 审核测试 9/9。
- oracle 实际编译，109 件全量源哈希/GLB 哈希/面几何重审完成；仅 6 个 unresolved 状态提升，原有匹配与交线差异均保留。
- 本片没有转换器或 GLB 改动，不重复转换、不声称网格或性能改善。转换仍来自上一片固定 `--sag 0.005 mm` 的完整 109 件证据。
- repository gate、rustfmt 和 diff-check 通过。完整审核因保留交线 mismatch 非零退出；模型和本地几何工件不入库。

```powershell
node scripts/audit-xt-face-geometry.mjs test-output/xt-face-geometry-oracle-spline.exe test-output/xt-native-periodic-reseam-final-20260917/evidence.json data/external-assets/industrial-format-plan/samples/downloaded/x_t/asmith-hinges test-output/xt-face-geometry-closed-spline-20260917.json
```

| 工件 | SHA-256 |
|---|---|
| 原转换 evidence.json | `748601f11f25f93ef11b91629544103acfc942b0121eaf99226387f9bb426aad` |
| 闭合样条 oracle | `74c0e9445d8fbaa4eaed8249eb3024ee87e6c67e484f000fc56ca0c248582e73` |
| 原始见证流 | `5675e1fc3c75e95e90603439587da1de69a50a411d86e96a338203bb8e056b1d` |
| 最终审核 JSON | `7339cf428e5122bbdb1824207fed7b1eaf2d6901891ff9b2ad9d20a8ab29393b` |
