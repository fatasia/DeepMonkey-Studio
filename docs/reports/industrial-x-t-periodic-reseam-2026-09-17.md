# X_T 周期重切保留真实边界点

AS, AT-2810L face 1259 与 AS, AT-2810R face 78 的同构圆柱边界超差已修复。109 件最终独立审核为 **`19337 matched / 1 mismatch / 6 unresolved`**，共 19344 个面。只有上述两面由 mismatch 变为匹配，没有状态回退；生产 profile 仍为 0。

## 根因

两个源面均为半径 3 mm 的圆柱，边界含上下完整圆和两个交线孔。分层诊断使用与语料 runner 一致的绝对 `0.005 mm` sag：源闭圆到已离散边链的最大距离为 `0.0048926882 mm`，到最终三角网格却为 `0.0176360728 mm`。因此不是源圆或初始采样精度不足。

`reseam` 为避开孔而旋转周期环时，把最后一个重复闭合点与真实点一起旋转。闭合点进入环内部、最后一个元素变为真实点；随后 `align_cuts` 仍按“末尾是重复闭合点”截断，删除了真实边界点，制造较长的弦。

修复把已有的 `begin_ring_at` 提取为小模块，重切和尝试新接缝共用它：只旋转唯一采样点，再由新起点重建周期闭合点；没有重复端点的开放采样环保持开放语义。参数只按整周期换支，保留源边链 XYZ，不重建圆、不针对模型名或面编号打补丁。

## 结果与成本

| 模型 / 源面 | 修复前边界差（mm） | 修复后边界差（mm） | 修复后支撑差（mm） |
|---|---:|---:|---:|
| AS, AT-2810L / 1259 | 0.0176360728 | 0.0048925877 | 0.0000059016 |
| AS, AT-2810R / 78 | 0.0176360728 | 0.0048925877 | 0.0000059016 |

独立 oracle 未修改，32 个源闭圆见证点和圆柱方程同时审核；固定 `0.01 mm` 预算不变。两面最终源见证哈希和三角指纹分别一致，修复覆盖左右型号共用机制。

109/109 转换成功且 GLB 计数一致。总三角数 `2064058 → 2064065`（+7），总字节 `75160004 → 75160160`（+156）。变化出现在两个目标型号及同机制的 AZ-03，后者增加 1 个三角形且审核继续匹配。最终本地运行约 62.73 秒；单次并行环境耗时不用于性能改善结论。

剩余 AS, AT-2810R body 24 face 360 的交线支撑差仍为 `0.0441604055 mm`；源域诊断不等同整个源文件损坏。6 个缺少受支持源见证的面保持 unresolved。本结果不是生产认证，也不是全部源几何已解决。

## 验证与复现

- 新增 4 个 Rust 回归：重切后对齐仍保留全部点、连续旋转/首尾索引、开放环保留末点、无孔及切口清晰时不改几何。
- 首轮完整测试暴露旧开放环夹具约定；实现保留该输入语义后，cad-export 39、cad-ir 149、cad-tess 44、cad-xt 18，共 250 个测试通过。
- Node 审核测试 9/9，repository gate、补丁 reverse-check、diff-check 通过；完整独立几何审核因剩余交线 mismatch 按约定非零退出。
- 阶段探针同步采用绝对 `0.005 mm`，仅诊断解析/边链/面片阶段，不作为独立 oracle。私有模型与 GLB 不入库，无新增商业或运行依赖。

补丁：[cadconvert-xt-periodic-reseam.patch](../../scripts/fixtures/cadconvert-xt-periodic-reseam.patch)，在上一片 [v 周期修剪补丁](../../scripts/fixtures/cadconvert-xt-v-periodic-strip.patch)之后应用。cadconvert 研究基线为 `73b37836a55f905ea0f392cf676dff160c745287`，保留既有研究补丁链。

```powershell
# cadconvert/native
cargo test -p cad-tess -p cad-xt -p cad-export -p cad-ir
cargo build --release -p cad-cli
# bim-studio 根目录
pnpm exec tsx scripts/verify-xt-native-corpus.mts data/external-assets/format-research/cadconvert/native/target/release/cadconvert.exe data/external-assets/industrial-format-plan/samples/downloaded/x_t/asmith-hinges data/external-assets/industrial-format-plan/samples/downloaded/x_t/asmith-hinges-inventory.json test-output/xt-native-periodic-reseam-final-20260917
node scripts/audit-xt-face-geometry.mjs test-output/xt-face-geometry-oracle-circle.exe test-output/xt-native-periodic-reseam-final-20260917/evidence.json data/external-assets/industrial-format-plan/samples/downloaded/x_t/asmith-hinges test-output/xt-face-geometry-periodic-reseam-final-20260917.json
```

| 工件 | SHA-256 |
|---|---|
| 最终转换器 | `8b9d67128be7393780a08ebad8ff102f454914453d392e58a1fce016d7588991` |
| 最终转换 evidence.json | `748601f11f25f93ef11b91629544103acfc942b0121eaf99226387f9bb426aad` |
| 最终独立审核 JSON | `be62271255febd98fdf6d460c006402764e0124277ee02474091c97ec520bfd8` |
| 独立闭圆 oracle | `c8869e3e362a5b8f893f16f993029c0e20202c06a87f1bdc1f54a8dba7288741` |
| 修复前阶段探针 JSON | `aeca88d5a96f9b1baba3d6c84e36b571ce13f10656c148e0c9813a730152b83c` |
