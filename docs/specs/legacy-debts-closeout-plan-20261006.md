# 老任务总账·收口计划(2026-10-06,用户指令:全部做完,不许忘)

> 门口径更新(用户拍板):**首帧 ≤500ms**(原 1500 门作废);能力 UE 级;性能/体积/效果极致;全程无 bug。
> 本文件是老任务唯一总账,收割续派以此为准;三线新任务书(deep2D/Semantica/round2 修复)并行不冲突。

## A. 性能轴(主线程亲自)

- **A1 首帧 ≤500ms**(现 2251ms,-78%):分段探针 `probe-deep-firstframe-cache.mjs` 先取基线构成 → 刀位按数据定:场景上传占比(历史证据 78%)、管线编译(磁盘缓存+预热+C26)、几何/纹理并行解码、JS 体积与解析、首帧最小管线集(只编译可见)、渐进首帧(骨架先出)。每刀真机复测,指纹判据防伪。
- **A2 内存峰值专项**(round2 P1-4):生产 soak 峰值堆 1458MB+42/62 窗 P95>50ms+pipeline-compile 长任务 261。定位管线驻留/纹理池/几何缓存账目,泄漏与水位双修,非 headless 复跑定标。
- **A3 输入 P95 保持 ≤7.2ms**:回归守护,任何优化不得劣化(门内已达标,列入每轮验证)。

## B. 能力轴(UE 级补全)

- **B1 TS↔Rust 差距 5-10**:native 视觉三件套/SSAO/sdf-gi native/megalights native/virtual-geometry/物理版本分轨(盘点在 docs/specs/ts-rust-parity-audit-20261005.md)。
- **B2 TS↔Rust 差距 1/4**:F2 RT evidence 补 rt.rs 就位事实/frame v8 双端 golden 对拍。
- **B3 UE 完整度缺口**:光追双通道/Lumen 式三层混合/簇级虚拟几何消费端/ReSTIR-DI(61 项口径 85.2%→100%)。
- **B4 a2c 设备探针 frames 接线**(框架已入,host 供给侧)。
- **B5 GI 变化区后续**:验证已收(门内遮蔽 0→280),剩余口径收尾。

## C. 编辑器轴(9 项补齐)

- 已收/在跑:关键帧+相机路径、物理调试(在跑)、材质图契约 Tier-2(今日收 7a9dfe7f)。
- 排队:Prefab、烘焙工作台、材质预设库、HUD、Shader Graph 轻量、VFX 图轻量——按"极致体验不堆砌"原则逐个过价值门再实施。

## D. 体积轴

- 现状 -49%(双份债+brotil -77%)。极致口径:bundle 预算门入 verify、wasm/native 体积复审、按路由代码分割复核,量化每步。

## E. 无 bug 轴

- round2 修复批次 A/B/C/D 全清(任务书 adversarial-round2-fix-plan-20261006.md)。
- 每刀交付纪律:复现测试+门不放宽+同族排查;verify 11 门+soak 门每批复跑。

## 执行顺序(当前在跑 3 路之外的主线程/续派队列)

1. 主线程:A1 首帧 500 攻坚(即刻开工,分段探针→逐刀)。
2. 收割后依序续派:A2 内存专项 → B1/B2 → C 排队刀 → B3。
3. deep2D 刀 2/3、Semantica UI、round2 B/C 按各自任务书穿插,owner 域互斥。
