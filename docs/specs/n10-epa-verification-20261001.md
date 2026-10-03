# N10 EPA 合同验证（2026-10-01）

## 现状核查

1. 全仓查询 `convexPenetration|convexDistance|EPA`（apps/packages 源码；排除大体量嵌入资源避免误命中）确认 EPA 已在 `apps/web/src/viewer/convexDistance.ts` 尾部，GJK/扫掠已完成。`git status --short` 的四个未跟踪项是受保护保留项，与本任务无关，不触碰。
2. 契约层 `packages/contracts/src/scene.ts` 已有凸包 collider 数据；本查询的 `WorldConvexBody/ConvexDistanceOptions/ConvexPenetration` 在模块本地，未发现重复 EPA 合同。保留原有形状与结果类型。
3. `apps/web/package.json` 已有 Vitest 4.1、Rapier 0.19.3、TypeScript 5.9；本项不增加依赖。
4. 消费方 `robotSweepCollision.ts` 使用 GJK 距离；EPA 尚无生产调用。不得把已验扫掠重写为 EPA，也不扩 UI 范围。
5. `convexDistance.test.ts` 与 `robotSweepCollision.test.ts` 已有 21 条 GJK/扫掠测试，原规格记录解析/Rapier 与性能证据；EPA 没有聚焦测试。报告/输出检索未发现 EPA 有效证据。
6. 已读 `glm-handoff-20261001.md`、`remaining-tasks-estimates-20260930.md`、`active-task-recovery-ledger.md` 与 `n10-narrow-phase-sweep-20261001.md`：N10 扫掠已经关闭，本项为 EPA 后继验证，独立收口，不改全局进度。

**已有（不重建）**：世界体变换、支撑映射、GJK、轨迹扫掠、EPA 入口/结果合同。

**真实缺口**：EPA 穿透深度、方向、接触点、切触/退化抛错与收敛标志没有解析验证；初始多面体与面符号逻辑需通过实际测试确认。

## 验证口径

- 球/盒及旋转盒使用解析 MTD；对方向唯一的用例检查交换方向、接触点差等于 `depth * normal`，平移 B 后恰接触、再多移后分离。
- 严格切触、分离、共面退化按公开合同抛错；低预算不能冒充收敛。
- 同输入两次逐位一致；刚体平移/旋转保持几何语义。
- 复跑 GJK 与扫掠聚焦测试；测试暴露根因后仅修本模块。

## 验证结果

`pnpm --filter @bim-studio/web exec vitest run src/viewer/convexDistance.test.ts src/viewer/robotSweepCollision.test.ts`：**48/48**（39 条距离测试，其中新增 27 条 EPA；9 条原扫掠测试），最终复跑 1.06 s。包含 12 个非轴向解析球对、旋转薄盒、小尺度球、低预算/重心重合与确定性。

`pnpm --filter @bim-studio/web exec tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --strict --skipLibCheck src/viewer/convexDistance.ts src/viewer/convexDistance.test.ts`：退出码 0；仅验证本切片，未声称全应用 typecheck。

首轮 7 条合同测暴露 3 项失败（球 seed 抛错、盒负深度、盒球未收敛），修复根因：

- 外向面距离 `n·p` 被写成 `−n·p`，导致负深度与支撑间隙反号。
- GJK 在线/面达到原点后仍归一零方向；补维路径始终拿最早四个轴点判定，>4 点数组也被误作四面体。保留碰撞单纯形、沿其正交维度补点、枚举真实四面体；球支撑方向统一归一化。
- 地平线反向边条件同时要求 `s === end` 与 `s !== end`，永假；内部边不抵消，拓扑增长失控。改为正确反向索引配对。
- 共面可见阈值 `1e-30` 把舍入误差当作新可见面；改用坐标/半径尺度的 32 machine-epsilon，保留用户收敛容差。
- 切触遇到支撑平面/收敛深度 ≤ 绝对容差时抛错；拓扑退化退出保持 `converged=false`。
- 小三角形被绝对 determinant 阈值误当退化；用正有限 determinant 比例求 barycentric，fallback 保留三条目权重（原两条目权重会使第三个点乘 undefined 产生 NaN）。该共享 GJK 修复通过原距离/扫掠复跑。

## 真实遗留

- 重心完全重合的球对 MTD 非唯一，默认迭代预算会返回确定的有限深度下界并标记 `converged=false`；已测试，未冒充精确深度。
- EPA 尚无生产 UI 消费，未运行 GPU/Cargo，未对全应用构建作结论；原 N10 扫掠关闭状态不变。
