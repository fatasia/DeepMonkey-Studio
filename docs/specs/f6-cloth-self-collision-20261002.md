# F6 布料自碰撞 CPU 核(2026-10-02,主线程切片)

## 现状核查

1. `docs/specs/f6-continuation-audit-20261001.md` 已明确真实缺口:动态双向互碰、自碰撞、软体 GPU 并行、Native 软体、持续帧性能未做;静态 primitive 接触、顶点流、PBR 帧循环 24 帧、原位 publication 均已验。工作树 clothSolver/softBodySolver/softBodyRuntimeHost/index 的未提交修改即上一刀静态接触的正式提升(34/34 已验),本切片在其上增量。
2. `clothSolver.ts` 已有 XPBD 距离约束 + 确定性风 + groundY + `contacts?.project` 两处投影点(积分后/约束后),本切片完全复用该接缝形态。
3. 自碰撞此前无任何实现(grep selfCollision 全仓无生产命中),不存在重复建设。

## 实现

- 新叶 `packages/deep-engine/src/physics/clothSelfCollision.ts`(约 130 行,≤300 门):
  `createClothSelfCollision({count, radius})` → `resolve(px,py,pz,inverseMass)`。
  空间哈希 cell=2r,计数排序预分配(bucketStart/order/bucketOfParticle/cellXYZ),零每帧分配;
  每粒子查 27 邻域桶,j>i 且 cell 复核相等才成对(hash 冲突过滤 + 每对恰处理一次)。
- 投影:`len < 2r` 时按质量加权各推 `(2r-len)·w/(wᵢ+wⱼ)`;`len===0` 沿固定 ±X 分离(确定性);
  锚点(w=0)作为 i 或 j 均跳过。
- `ClothSolverConfig.selfCollisionRadius?: number`,构造期校验 `2r ≤ spacing`(拓扑相邻粒子距离 ≥ spacing,
  天然不触发,无需排除集);step() 在两处 contacts 投影后各调用一次,顺序固定 contacts→self(确定性)。
- 四面体软体(SoftBodySolver)**不接**:体积软体自碰撞语义(表面粒子对)不同,后继单列。
- runtime host / 运行包 schema 不动:第一刀是 solver 级 API,SDK 暴露后继。

## 验收(全部实测通过)

- 新聚焦测试 `clothSelfCollision.test.ts` **7/7**:
  构造合同负例(radius 0/负/NaN/∞、count 0、2r>spacing);
  落布堆叠场景 12×12/spacing 0.05/r 0.02/240 tick,窗口 tick≥180:
  禁用负控真实穿透(min<2r,场景有证明力)、启用 min≥0.9·2r、拉伸 maxRatio≤5%、
  开关终态指纹不同;锚点两角 240 tick 位置逐位不动;同参数双跑逐位;第 100 步快照回放逐位。
- 同族回归 `src/physics/` 23 文件 **151 passed + 3 既有 skip**,零回归。
- `pnpm typecheck`(src/lab/examples 三段)exit 0。

## 如实边界

- 单遍投影近似:不承诺任意时刻完全无穿透(高密度堆叠下与距离约束拉锯,窗口门 0.9·2r 是声明验收线);
  contacts(障碍)与 self 顺序固定但两者同时完全满足不作合同。
- 数值门 0.9·2r 是本场景实测声明,非任意参数域的形式化证明;2r≤spacing 合同只保证拓扑相邻不触发,
  不约束非相邻初始重叠(初始重叠由首子步投影分离,d2===0 固定 ±X 破缺)。
- CPU f64 参考核:GPU 并行核、运行包 SDK 通道、软体自碰撞、动态障碍互碰均后继,本切片不关闭 F6/T18-collision 整行。
- 测试初稿锚点用例错把粒子 0 当锚(修正为 (0,11)/(11,11));空间哈希最后一桶终点漏写 bug 在自检中发现并修复(prefix 循环后显式写 bucketStart[BUCKET_COUNT])。
