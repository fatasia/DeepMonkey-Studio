# DE26/A01 · 五引擎目标矩阵 v2(冻结)

日期:2026-09-17。卡:DE26/A01(P0)。合同模块 `packages/deep-engine/src/benchmarkTargetMatrix.ts`,v1 `benchmarkContract.ts` 未动(8 项回归保持)。

## 冻结内容

- **五张矩阵独立判定**:three / babylon / unity / ue5 / godot 各一张,互相不抵扣。
- **引擎身份**:version/renderer/platform(+rendererProfile);version 为空或 `unlocked` 的矩阵**永远不能判 passed**(A05–A07 锁版本后才可能通过)。
- **双赛道**:`common-baseline`(公共子集,quality=equivalent)与 `best-quality`(最佳质量,quality=best);公共基线混入最佳口径即构造失败。
- **必选任务**:六类负载(工厂实例/异构BIM/远原点园区/动态工作单元/混合看板/外观展示)是每张矩阵的下限,缺一即 invalid;引擎可追加 case。
- **必选能力**:离线交付等进固定分母;**禁止退化项**逐条观测,observed 即判负。
- **排除项**:显式登记(reason+ruling),不进分母、永不计通过;排除 id 若出现在证据里按越权评分拒绝。
- **权重防篡改**:case+能力权重按域合计必须精确等于 v1 冻结的 `CAPABILITY_DOMAIN_WEIGHTS`(合计 100),不等即 invalid。
- **分母固定**:`denominator = cases + requiredCapabilities`;缺失证据按 unverified 留在分母,绝不折算成有利结论;无证据的 passed 按构造拒绝。

## 判定语义(`evaluateEngineTargetMatrix`)

- passed = valid ∧ 身份锁定 ∧ 无 failed ∧ 无 unverified ∧ 无禁止退化命中 ∧ 无任何 issue。
- critical case/能力 unverified 或 failed → 直接失败并列名。
- 矩阵形状非法 → valid=false、denominator=0,不产出任何分数。

## 测试与边界

- `benchmarkTargetMatrix.test.ts` 6 项:五矩阵构造/权重与分母篡改拒绝/全通过路径/unverified 留分母+critical 失败/无证据 pass 拒绝/禁止退化命中/排除项越权评分拒绝/unlocked 永不通过/非法矩阵零评分。v1 回归 8 项通过,deep-engine typecheck 通过。
- 边界(如实):本卡只冻结**判定合同**;真实引擎版本、环境 hash、样本与配对观测由 A02/A04/A05–A07 提供后才能产出真实 verdict;矩阵的 JSON 实例落盘(含五引擎 rendererProfile 档位)在 A04 领取时按当时锁定值生成。
