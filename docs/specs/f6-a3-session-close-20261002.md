# F6-A3 关闭:生产换核真机复验 + 缓冲会话化 + 核选择会话口径(2026-10-02,主线程攻坚)

> 估时表 F6-A3:"生产换核后全 substeps 单 pass 真 GPU 复验、FMA 容差/核选择会话口径与缓冲会话化"(4-8h,中信心;底座 3206952f/b06d8086)。**三项全部完成,行关闭。**

## 实现

1. **缓冲会话化**:新叶 `softBodyGpuDispatch.clothSession.ts`(~230 行,不动已验 298 行换核文件)——`createClothGpuStepSession(device, input, {kernel})`:约束/物理参数/GPU 缓冲(5+色数个)/绑定组构建期一次创建;`step(particles)` 每 tick 只写粒子状态并复用全部缓冲,单 pass 全 substeps 一次 submit;`dispose()` 幂等销毁;设备错误后会话 dead(fail-closed,调用方重建)。serial 会话提供核钉死语义(buffersCreated=0,串行文件域不动)。
2. **核选择会话口径**:options.kernel 显式钉死 "cloth-parallel"|"cloth-serial"——确定性重放调用方不再依赖"auto 无粘性+按结果字段锁定"约定;auto 换核开关保持默认不变。已验文件仅增 2 行纯增量(noteClothParallelSessionStep 遥测口径复用)。
3. **真机复验(首项)**:probe 新增 `runClothParallelGpuProductionReplay`(生产入口 dispatchClothStepAuto 真机路径——此前 probe 只覆盖裸 WGSL 重放,不经过换核开关),runner 增补 production 证据字段与判定门。

## 真机验收(Chrome WebGPU,exit=0;证据 test-output/cloth-parallel-gpu-20260929-r1/evidence.json sha256 b55fa562…)

- **生产入口 64 tick**:kernel="cloth-parallel" 且无回退(fallbackSeen=null)——真机并行核可达;24 tick 对拍 CPU f32 镜像最大 **1.1e-5**(FMA 域);终点 f64 黄金 **0.0103 ≤ 0.05**。
- **会话化 240 tick**:buffersCreated=**13**(5+色 8,构建期一次,step 零创建);**会话输出与逐调用同输入逐位一致**(bitwiseEqualsPerCall=true——缓冲会话化数值零改变);黄金 **0.0090 ≤ 0.05**、镜像 0.0054、拉伸 **2.313% ≤ 5%**。
- 既有裸 WGSL 重放回归不动:replayBitwise=true、golden 9.003e-3、拉伸 2.313%(与 A3 历史值一致)。

## CPU 侧

- 会话合同测试 2/2(kernel 枚举校验、遥测口径);物理域 **26 文件 161 passed + 3 既有 skip** 零回归;src tsc exit 0;index.ts 导出会话 API。

## 如实边界

- 会话物理参数构建期冻结(每 tick 仅粒子可变,与 ClothSolver 会话用法一致);设备错误后会话 dead 需重建。
- FMA 容差沿 A3 登记口径(真机 vs 镜像非逐位,240 tick 累积 ≤0.05 带内),本切片未改数值语义。
- 风场碰撞 GPU 侧与软体 GPU 并行是 F6/T18 行的清单项,不属 F6-A3 范围,不因此关闭。
