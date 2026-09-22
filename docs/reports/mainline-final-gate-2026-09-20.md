# 主线 FINAL-GATE 第一轮（2026-09-20）

本轮功能、确定性与渲染回归已完成首轮签核。项目终验仍后置：待其余核心能力收口后，再执行编辑器全接入、Deep Native 交互、Web 视觉等效与 Native 性能超越 Web 的整体验收。

## 首轮结果

| 门禁 | 结果 | 证据与边界 |
|---|---:|---|
| 仓库治理 | 通过 | `pnpm gate:repository`，5 项测试通过 |
| 项目源文件体量 | 通过 | `pnpm quality:source-size`，最新 5393 个源文件均不超过 800 行，无豁免 |
| 公开品牌与产品图标 | 通过 | `pnpm quality:public-brand` |
| Web 类型检查 | 通过 | `pnpm --filter @bim-studio/web typecheck` |
| Web 全量测试 | 通过 | 652 文件通过、3 跳过；3874 测试通过、3 跳过，0 失败（`maxWorkers=4` 完整复跑） |
| Studio Core 全量测试 | 通过 | 14 文件 / 106 测试，0 失败 |
| API 全量测试 | 通过 | 217 文件通过、1 跳过；1407 测试通过、12 跳过，0 失败 |
| Deep Engine 全量测试 | 通过 | 423 文件；3442 测试通过、42 跳过，0 失败 |
| Deep Engine 类型与纯度 | 通过 | 双 tsc；runtime policy 14/14；purity：browser/core 669、native 577、Windows packages 324 |
| Native 全量（非 LPAC） | 通过 | 143 个 suites；1374 测试通过、129 ignored，0 失败；`cargo check --locked --all-targets` 通过 |
| R10 native/WASM 确定性 | 通过 | Rust 19 项；F04–F07 native/WASM 位级一致且 WASM 双跑一致，见 `test-output/final-gate-r10-determinism-20260920/` |
| R12 真 WebGPU 回归 | 通过 | direct / SSR / defaults / transparent 4 场景，最新证据 `test-output/r12-frame-capture-1789911884763/` |
| Web / Native 2D 对拍 | 通过 | 6/6；SSIM 0.9816–0.9913，见 `test-output/final-visual-pair-20260920/deep2d/` |
| Web / Native 3D 对拍 | 通过 | GI-on SSIM 0.994162、edge F1 1.0；GI-off SSIM 0.997363、edge F1 0.999169，见 `test-output/final-visual-pair-20260920/deep3d-r4/matrix.json` |
| 主线收口索引 | 部分通过 | `test-output/final-gate-20260920-r2/closure.json`：5 passed / 3 partial / 0 blocked / 0 unverified |

Windows PowerShell 拒绝路径测试的真实执行时间超过 Vitest 默认 5 秒，已将该测试自身预算对齐到内部 15 秒进程上限，并保留全部安全断言。

## 本轮收口内容

- R10：F04–F07 native/WASM 确定性闭环；产品 PhysicsWorld 固定步长宿主；转动关节轴、限位、速度马达、求解强度、保存恢复和悬空关节清理。
- R12：真实 render-loop 捕获、真 GPU 证据和作者 Source Map 查询 UI；诊断按需开启，最多保留 24 帧，关闭时不进入热路径。
- R2 / R6：DCIR buffer-only ABI 与真实 GPU 粒子 indirect 消费；PBR deform 与 clustered-light 多编码器准备合并为一次队列提交。
- G7：体积雾 march → HDR 合成 → SSR → TAA → bloom 生产链；默认关闭，实际执行图与捕获证据一致。
- R11 / P5 / P7：动画状态机、显式转场与 Web/Native 运行合同；工程分析及空间/QTO JSON、CSV 导出入口。
- C3：Deep2D 相邻 draw 顶点上传合批；仅 sampler revision 变化时复用纹理与视图，像素变化仍上传。

## 已知边界

- Deep Engine 的严格 300 行审计仍报告 73 个既有/并行 WIP 超限文件；本轮新增或扩展文件均已压回门内。项目级 800 行硬门禁已通过；未修改阈值或加入豁免。
- Native 全目标剩余 13 项均依赖 LPAC Worker；本机 Windows 在进程启动时统一返回 `0xc0000022`（Access Denied），覆盖 5 个 LPAC 测试文件。非 LPAC 的 1374 项为 0 失败，不能据此把 LPAC 能力签核为通过。
- 视觉证据支持“接近一致、结构等同”，不支持宣称 Native 明显优于 Web。对拍中发现并修复 Native local-light 帧标记始终为 2、导致 GI-off 不消费 point/spot light 的真实回归；修复后真实 Windows GPU 测试通过。
- 主线索引的 3 项 partial 属于更广的项目后验收、工业 S1–S6 与资产源级 readiness，不是本轮 R10/R12 回归失败。
- Rapier 0.19 JS 没有可验证的关节最大扭矩接口；当前产品“强度”是求解器强度，不冒充扭矩预算。动态 MultibodyJoint、双刚体作者入口与 native 产品宿主仍在后续能力清单。
- 固定夹具结果不扩大为任意客户项目能力。最终的客户端视觉、交互和性能结论必须由后置整体验收给出。

## 最终验收顺序

1. 收完剩余核心性能、效果、能力接线，并确认底层能力在上层编辑器存在真实入口和运行消费。
2. 完整生成并启动 Deep Native，覆盖交互、动画、物理、2D/3D、发布依赖和无控制台窗口。
3. 对同一项目执行 Web 与 Native 视觉对拍；2D/3D 效果达到等效或更好。
4. 在相同设备、场景与质量档下执行帧时间、吞吐、显存和长帧对比；只有证据证明 Native 优于 Web 才签核性能目标。
5. 修复所有发现项后执行第二轮全量测试和最终签核。

## 复现

在仓库根目录执行：

```powershell
pnpm gate:repository
pnpm quality:source-size
pnpm quality:public-brand
pnpm --filter @bim-studio/web typecheck
pnpm --filter @bim-studio/web test
pnpm --filter @bim-studio/studio-core test
pnpm --filter @bim-studio/api test
```

R10、R12 与主线索引使用上表中的证据目录复核。本轮不提交、不推送。
