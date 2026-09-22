# 主线收口证据索引（2026-09-18）

本文件是 ①–⑦ 的收口入口，不把局部成功改写成整项完成。机器可读结果由
`scripts/verify-mainline-closure.mjs` 生成到 `test-output/mainline-closure-20260918/closure.json`。

| 项 | 当前判定 | 证据边界 |
| --- | --- | --- |
| ① 剖切 E2E | 以脚本结果为准 | 同一 Native EXE、同一场景，两轮剖切/未剖切客户区读回；检查重复稳定和差异字节。 |
| ② 动态场景运行包 | `partial` | Runtime Package v7 已有 `dynamic-runtime` resource/entrypoint、TRS 编译映射和 Native PlayerContent 消费；WebGPU/Native 播放实窗与确定性重放仍缺。 |
| ③ V11 Nature Kit | `blocked` | 48 个候选 GLB、来源哈希、缩略图、grounded-derived 门禁和素材中心本地目录已机器核验；真实场景拖放/保存重开仍需处理。 |
| ④ 发布链 OS 证据 | `passed` | 无参数单 EXE、API 停止、无 sidecar、客户区逐像素复现和隔离启动；本机模拟无网通过。 |
| ⑤ GI 跨端一致性 | 以矩阵阈值为准 | Native 烘焙消费和重复读回已通过；WebGPU↔Native 的亮度/噪声残差必须经过结构/曝光归一化阈值，不能直接套 Dashboard SSIM。 |
| ⑥ D24–D28 项目级后验收 | `partial` | A04/A08 成对基准和发布恢复证据可复用，但三资产、多通道、跨端、长稳和完整视觉门禁仍未形成独立综合结论。 |
| ⑦ 工业 S1–S6 | `partial` | S1 任务/租约/幂等与各格式增量证据已入账；未声明 profile、混合场景、干净 OS、许可闭包和项目级回滚仍保持 inspect/preview/待验收。 |

## 复跑

```powershell
node scripts/verify-mainline-closure.mjs
node --test scripts/lib/kenneyNatureAdmission.test.mjs
```

脚本只校验已有证据的身份、哈希、重复读回和明确边界；`blocked`、`partial`、`bounded-deferred` 是有效的诚实结果，不会被折算为通过率。
