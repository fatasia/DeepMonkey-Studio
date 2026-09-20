# GI relocation 闭环专项任务卡（波次2，2026-09-21）

> 供子代理直接执行的完整规格。现状核实全部来自 2026-09-21 主线程代码走查，路径均可追溯。

## 现状（已核实，不要重建）

| 组件 | 状态 | 位置 |
|---|---|---|
| 采样端 relocation 消费 | ✅ ABI v1：`probePosition = 格点 + record.relocation.xyz` | `packages/deep-engine/src/lighting/probeClipmapSamplingWgsl.ts`（83 行）|
| 切比雪夫泄漏加权 | ✅ `deepGiVisibility`（mean/variance/floor） | 同上（50-58 行）|
| CPU record 编码 | ✅ `packIrradianceProbeRecord`（positionOffset 通道在位）| `probeClipmapSampling.ts:51` |
| CPU 参考采样 | ✅ `sampleIrradianceProbeClipmap` | 同上：66 |
| **relocation 求解器** | ✅ 本轮新增 `computeProbeRelocation`（埋入逸出/贴面推开/0.5 cell 上限/幂等）| `probeRelocation.ts` |
| **GPU 捕获 ↔ CPU record 汇合** | ❌ `packIrradianceProbeRecord`/CPU 采样**无任何生产消费方**；GPU capture 的 record 写入独立于 CPU 路径 | 本专项核心 |
| **relocation 更新触发** | ❌ 无调用方在 probe 更新时求解偏移 | 本专项核心 |

## 任务（闭环定义）

1. **接线**：在 probe 更新调度（`planIrradianceProbeClipmap` → updates 列表）与 surface cache（`ProbeSurfaceCache` 遮挡体集合已具备）之间，为每个更新探针调用 `computeProbeRelocation`，产物进入 record 的 positionOffset 通道。选择汇合形态（CPU 写入 storage 或经 capture adapter 传入 GPU 编码）时给出理由；两者都要求：未知/越界偏移 fail-closed、既有 GPU 路径字节不变（除非写偏移）。
2. **更新触发**：探针在滚动/初始/dirty 三种 reason 下都执行求解；偏移变化本身构成下一帧 dirty 的证据链（可收敛，需防抖：偏移量 < 0.05 cell 不再触发）。
3. **时域安全**：偏移变化时 probe irradiance/visibility 的历史有效性按既有 revision 体系失效（避免旧光照在错误位置闪现）。
4. **测试**：
   - 求解器→`packIrradianceProbeRecord`→`sampleIrradianceProbeClipmap` 的 CPU 闭环 roundtrip（偏移后采样几何改变、权重向逸出方向倾斜）；
   - 幂等（两次求解零偏移）、跨帧收敛（深度穿透 ≤2 帧迭代落位）、fail-closed；
   - GPU 侧若有改动：stub 设备 focused 测试 + 真机证据按批次 F 约定后置。
5. **验收签名**：closed-form 断言全部过 + `npx tsc --noEmit -p tsconfig.json`（deep-engine）双配置干净 + 既有 probeClipmap* 测试零回退。

## 边界（诚实条款）

- 本任务卡不含 SSR→probe→environment 三级回退的 UI 可见性（那是后处理面板域）；
- 不要求真机 SSIM（批次 F 统一）；CPU 闭环 + 结构接线即算本卡完成；
- 禁止改 sampling WGSL 的 ABI（版本号不动，字节布局不动）。
