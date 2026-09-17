# X_T 圆环小圆周期修剪

AS-0820 的三个圆环面边界缺口已消除。固定 `--sag 0.005 mm`、独立源见证预算 `0.01 mm`，109 件复核由 `19332 matched / 6 mismatch / 6 unresolved` 变为 **`19335 matched / 3 mismatch / 6 unresolved`**，没有状态回归，生产 profile 仍为 0。

## 根因与实现

源 face 10596、10619、10672 分别对应 body 12 的内部面 11、6、15。每面由两个完整小圆围成，小圆沿 TORUS 的 **v 周期**绕行，u 为常量。旧修剪路径只识别 u 环：第一次把两条零面积 UV 线送入闭域处理；重试携带 u 接缝时，浮点微小回退被提升为多个 u 周期。最终降级重建的顶点仍在源环面上，但没有覆盖完整源圆边界。

源圆点代入独立环面方程，最大残差均小于 `7e-15 mm`，排除了这三处源闭圆与支撑曲面不相容的假设。

新增局部 `v_periodic_strip` 模块：仅处理环形 TORUS、两个单边完整 CIRCLE、常 u 且方向相反的 v 绕环；保留已有源边链坐标，用面朝向选择物料所在 u 区间，在共同 v 切口补两条坐标一致的接缝，再交给既有三角化。跨 u 缝和反向面按相同规则处理。不扩大为任意周期修剪，不处理角点、部分圆弧或自交圆环。

## 独立几何结果

| 源面 | 修复前边界最大差（mm） | 修复后边界最大差（mm） | 修复后曲面最大差（mm） |
|---|---:|---:|---:|
| 10596 | 0.0244296350 | 0.0008508245 | 0.0000003852 |
| 10619 | 0.0274819414 | 0.0008507563 | 0.0000002348 |
| 10672 | 0.0488295413 | 0.0008507824 | 0.0000001201 |

109/109 转换与 GLB 计数一致，0 件失败。审核逐源文件哈希、逐 GLB 哈希、逐面边界/支撑见证；只有上述三面的状态改变。剩余 AS, AT-2810L face 1259、AS, AT-2810R face 78 仍有 `0.0176360728 mm` 边界差，face 360 的交线仍有 `0.0441604055 mm` 曲面差；6 个 unresolved 不变。

网格由 2043167 增至 2064058 个三角形（约 +1.02%），总字节由 74722700 增至 75160004（约 +0.59%）。本轮转换与审核耗时约 48.56 秒，单次运行不作为性能改善证据。

## 验证与复现

- 新增 3 个 Rust 测试：源点完整保留/不同相位双接缝、跨 u 缝与反向面物料选择、缺环/非小圆/同向/不完整绕行拒绝。
- cad-export 39、cad-ir 149、cad-tess 40、cad-xt 18，共 246 个测试通过；Node 独立审核测试 9/9。
- 补丁 reverse-check、repository gate、diff-check 通过。完整几何审核因剩余 3 个差异按约定非零退出。
- 模型和本地 GLB 不入库；本片是已有开源研究路径补丁，未新增运行依赖，未升级生产能力。

补丁：[cadconvert-xt-v-periodic-strip.patch](../../scripts/fixtures/cadconvert-xt-v-periodic-strip.patch)。在既有 cadconvert `73b37836a55f905ea0f392cf676dff160c745287` 研究补丁链之后应用，再执行：

```powershell
cargo test -p cad-tess -p cad-xt -p cad-export -p cad-ir
cargo build --release -p cad-cli
# 回到 bim-studio 根目录
pnpm exec tsx scripts/verify-xt-native-corpus.mts data/external-assets/format-research/cadconvert/native/target/release/cadconvert.exe data/external-assets/industrial-format-plan/samples/downloaded/x_t/asmith-hinges data/external-assets/industrial-format-plan/samples/downloaded/x_t/asmith-hinges-inventory.json test-output/xt-native-v-periodic-20260917
node scripts/audit-xt-face-geometry.mjs test-output/xt-face-geometry-oracle-circle.exe test-output/xt-native-v-periodic-20260917/evidence.json data/external-assets/industrial-format-plan/samples/downloaded/x_t/asmith-hinges test-output/xt-face-geometry-v-periodic-20260917.json
```

| 工件 | SHA-256 |
|---|---|
| 转换器 | `d39d76e2356f98c7fd544f89e7321fd4a43aa685bf6569565910566106b06105` |
| 转换 evidence.json | `305b6c7eb0c8744af7c9cd24e50aa6db4d8a810421cfc2ff149322d73b56fc3d` |
| 独立闭圆 oracle | `c8869e3e362a5b8f893f16f993029c0e20202c06a87f1bdc1f54a8dba7288741` |
| 强化审核结果 | `3380d74a913ec18c771e8f7f8956bfa0a5690f0cb64785fe13768e120e0cc2a4` |
