# P4-B 实验性 RT 路径设计与 Benchmark 方案（2026-09-15）

状态：**设计冻结、实现保留**。按交接约束“若无真实项目收益，保留能力探测和设计，不宣称生产
完成”，本文是 P4 的完整技术方案与可复现 benchmark 规格；未写任何 RT 渲染代码，不宣称生产。

## 1. 当前事实（诚实结论）

- wgpu 30.0.1 不暴露任何 RT 能力：`Features` 无 acceleration-structure / ray-query 位，
  无 RT pipeline/binding API。任何“先写 RT 代码”的尝试都必须 fork wgpu 或引入 Vulkan
  手写层——两者都是未经批准的重大依赖动作。
- 因此 `host_capabilities::rt_probe` 冻结了能力合同：全部厂商
  `Unsupported(backend-lacks-rt-api)`，feature flag 默认关，fallback 永远是现有光栅路径。
  当 wgpu 升级暴露 RT 后，只需改 `probe_adapter` 一处，renderer/材质/光照合同零改动。

## 2. 候选实验排序（按价值/成本）

| 候选 | 价值 | 实验成本 | 依赖 | 决策 |
|---|---|---|---|---|
| RT 阴影（太阳/局部光 1SPP+时域滤波） | 高——软阴影/接触阴影超出 CSM 质量 | 中：TLAS/BLAS 构建每帧、1 ray/pixel | wgpu RT API + 真实项目 | **首选**（Deep Lights 的阴影槽可平替实验） |
| RT 反射（屏幕空间失效区域回退 RT） | 中高——玻璃/水面高价值 | 高：命中着色复用 PBR 全管线 | 同上 | 次选 |
| RT GI Lite | 低——Deep GI Lite 已覆盖目标质量 | 最高 | 同上 | 暂缓 |

## 3. 实验路径结构（获准入后实施）

```
src/rt/
  mod.rs            # 只暴露 RtExperiment::probe/validate，不进渲染图
  blas_build.rs     # BLAS：静态几何每 mesh 一次，动态实例 TLAS 每帧 refit
  shadow_pass.rs    # 1SPP shadow ray + RV truncated mean 时域积累
  benchmark.rs      # §4 的固定场景与报告 schema
```

硬边界（交接约束的落实）：
- `src/rt/**` 不被 `renderer/**`、`mesh_pass`、Deep Lights、Deep GI Lite 引用；
  实验通过 feature flag `rt-experiment` + capability 双门进入，关 flag 时零代码路径。
- 不修改统一 RenderPacket 行为合同；BLAS 输入是 packet 的只读投影。

## 4. 可复现 Benchmark 规格（先于实现冻结）

固定场景：`fixtures/` 内 3 个真实项目包（工厂/电站/仓储，各 ≥50 万三角形、≥200 实例）。

| 指标 | 采样 | 通过线（首版） |
|---|---|---|
| BLAS 构建时间 | 每 mesh，P50/P95 | <8ms/10 万三角形 |
| TLAS refit | 每帧 P95 | <0.8ms @500 实例 |
| 阴影 pass GPU 时间 | 600 帧 P50/P95 | <2.5ms @1080p（1SPP+滤波） |
| 质量 | 离线 4K 参照 vs RT 1SPP | SSIM ≥0.92 |
| 稳定性 | 连续 20 分钟 | 无 device loss、显存回落 ≤预算+10% |

报告 schema（`benchmark.rs` 输出 JSON）：adapter/driver/backend/feature/预算/asset hash/
降级原因（继承 rt_probe 合同字段）。硬件覆盖：RTX 4060 Laptop（Vulkan）+
一个非 NVIDIA 适配器；无第二适配器时如实记录 `NotMeasured`，不以估算代替。

## 5. 与 P3/P0-P2 的接口影响

- 零影响：本设计未改任何共享文件；`host_capabilities/**` 为新增隔离模块。
- wgpu 升级（未来获 RT）属共享合同变更，届时先提交依赖方案再动 `Cargo.toml`。

## 6. 完成定义对照

- 能力探测 + 降级合同：**已完成**（rt_probe 3/3 测试，矩阵可序列化）。
- 实验路径：**保留**（本文档即全部交付，符合“不宣称生产完成”约束）。
