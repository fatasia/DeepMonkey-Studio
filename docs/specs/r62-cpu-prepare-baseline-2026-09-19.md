# R6-2 基线首批数字(2026-09-19 深夜,主线程)

场景:BIM 型 5000 实例(2 几何 × 5000 变换实例,`scene_content_key dee4b2b0…`),Native 播放器,`--smoke-telemetry` 6 采样帧(2 预热),release 构建,Windows,RTX 4060 Laptop,**Vulkan 后端**,驱动 595.79。机器当时有并行车道负载(另两 Chrome 实例),数字按首批基线记账,不写最终结论。

## 实测(样本原始值,未修整)

| 通道 | 样本(ms) | 中位 | 判读 |
|---|---|---|---|
| **cpu-submit** | 3.39 / 3.32 / 3.35 / 3.25 / 3.19 / 3.63 | **3.35ms** | 每帧 CPU 提交准备+提交 |
| **frame-interval** | 5.37 / 5.31 / 5.41 / 4.79 / 6.40 | **5.37ms** | 实际帧节奏 |
| gpu frame(timestamp) | p50 394µs / p95 442µs | **0.394ms** | GPU 全帧 |

**CPU 提交占帧间隔 62%——远超 30% 红线,R6-1 热点档被数据正式触发**(此前"GPU 99.6% 空闲"的判断在本场景得到复现:GPU 只用 0.394/5.37 ≈ 7%)。

## 边界与未覆盖(如实)

- 未覆盖通道与原因(遥测合同如实降级,不伪造):scene-update/upload 未独立埋点(`native_scene_update_is_not_isolated_from_resource_preparation` / `native_upload_is_not_timed_as_an_independent_boundary`);present 无合成器完成时间戳。**C3/A 组需要的 prepare 细分(遍历/编码/资源准备)还不能从本报告拆出**——细分埋点是下一步(原估半天,维持)。
- 5000 实例复用 2 个几何(实例化正确形态);六类负载矩阵与 20000 实例档待扩。
- 单场景 × 6 帧;多场景 × 长窗口为后续正式测量。

## 决策含义(按 R6-1 卡阈值)

1. cpu-submit 占比 62% → **热点档合法启动**,候选按 R6-1 路线图(队列串行化/barrier/map 批处理),全部过确定性门禁;
2. R6-2 的 C2(并行 encoder 农场)与 D 组(uniform 竞技场)优先级上调——3.35ms 的主体大概率是 per-instance 编码与绑定创建;
3. GPU 空闲 93% 再次确认 A 组驱逐策略(几何/文字上 GPU)有巨大预算空间。

证据:`test-output/r6-2-cpu-prepare-20260919-r1/`(telemetry-report.json 原始 JSON + 场景包 + packet + 生成脚本 `scripts/fixtures/gen-r62-cpu-prepare-scene.mts`,幂等)。
