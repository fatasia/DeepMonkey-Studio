# F6/T18 软体 GPU 并行核·第一刀:体积约束四面体着色(2026-10-02,主线程攻坚)

> 软体并行是 F6/T18 行最后大块(估时内嵌于 12-24h 低信心行)。本切片完成 CPU 着色核;WGSL 并行 project/双端镜像/真机复验为第二、三刀(跨批续作)。

## 现状核查

- 串行软体核(`softBodyGpuWgsl.ts` 头注释)自证:"intentionally serial ... before a production parallel coloring scheme is introduced"——并行化正是设计预留;边约束族着色可直接复用 `colorClothConstraints`(同 2-粒子形态);**体积约束 4-粒子着色无任何实现**(全仓零命中)。

## 实现

- 新叶 `softBodyVolumeColoring.ts`(约 100 行):`colorSoftBodyVolumes(tets, particleCount)`——
  共享任一粒子的两个四面体冲突(体积投影动 4 粒子,同子步每粒子只被一个体积约束投影);
  粒子→tet 倒排一次构建邻接,确定性贪心(构建序取最小可用色),输出与 ClothColoring 同构
  (colors/colorCount/order/colorRanges/maxTetDegree)——并行 dispatch 编排直用。

## 验收(实测)

- 新测试 **5/5**:非法输入拒绝(count/越界/负索引);单 tet 单色;共享面/共享单粒子两 tet 异色;不相邻同色;五 tet 链逐对冲突异色+星形(中心粒子 4 tet)≥4 色;确定性双跑同色+order/colorRanges 全覆盖。
- 物理域 **26 文件 166 passed + 3 既有 skip** 零回归;src tsc exit 0;index 导出。

## 第二刀(本批完成,同日)

- `softBodyParallelSolverWgsl.ts`:并行 WGSL 单源——四入口(integrate/边色批 project/体积色批 project/finalize),多 workgroup(64/批),ABI 与串行核完全一致(particles 48B/edges 16B/tets 32B/params 48B);体积投影四角 XPBD 梯度与串行核逐句同源;色批 range uniform 由 TS 着色驱动,同色批无共享粒子(storage 并发写安全)。
- `softBodyGpuDispatch.softbodyParallel.ts`:dispatchSoftBodyParallelGpuStep——单 pass 全 substeps 一次 submit(integrate → 边色批 → 体积色批 → finalize),编排计数 = substeps×(2+边色数+体积色数);pack 复用串行核函数(ABI 一致由 CPU 测试钉死)。
- CPU 合同测试 2/2(pack 布局逐字节长+params 槽位、编排计数);物理域 28 文件 **168 passed + 3 skip** 零回归;tsc exit 0;index 导出。

## 第三刀(镜像完成,同日;真机复验续作)

- `mirrorSoftBodyParallelStep`(softBodyGpuDispatch.softbodyParallel.ts):色批序 f32 镜像——per substep integrate → 边色批(桶序)→ 体积色批(桶序)→ finalize,投影单约束数学复用串行文件导出的 projectEdge/projectVolume(f32 逐句同源)。并行与串行镜像投影序不同、彼此不逐位(布料换核合同同款声明);同核双跑逐位。
- 镜像测试 4/4(pack ABI 逐字节+params 槽位、编排计数、单约束退化色数 1 时与串行镜像**逐位一致**、多约束投影序不同单 tick 容差 ≤1e-5+双跑逐位);物理域 28 文件 **170 passed + 3 skip**;tsc exit 0。
- **真机复验(本批完成,exit=0)**:probe runSoftBodyParallelGpuCheck(8 粒子/12 棱/6 tets 立方体软体,首 tet 锚定);**双跑逐位=true**、镜像容差全过(24 tick 2.6e-5→120 tick **4.16e-4**,FMA 域与布料 9e-3 同族);evidence sha256 93510a40…(softbodyReplayBitwise/softbodyMirrorTolerance 双 true,production/session 既有门同绿)。
- **真机复验暴露并修复两个真实缺陷**:①dispatch 色桶索引错位——pack 按原序而 colorRange 索引桶序(执行错误约束集+并发写冲突),修复=按 coloring.order 重排 pack(与布料并行核同索引空间合同);②欠约束场景混沌放大(free DOF>约束,12 棱全约束修正场景设计)。镜像逐步对拍由此真实成立。

- 第三刀:TS f32 镜像(软体版 ClothParallelMirror)+双端逐位合同+真机复验(沿 clothParallelGpuTest 骨架)。
- 边界如实:CPU 着色核不构成软体 GPU 并行能力存在;色数上界=maxTetDegree+1(3D 内部 tet 邻接可达 20+,色批数多于布料是预期,性能权衡真机测)。
