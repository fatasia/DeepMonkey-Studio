# Deep Engine 重新汇总与 GLM 交接审计（2026-09-14）

注意：本文件是 Deep Engine / GLM 40 项的专项审计，不是整个 Deep Monkey Studio 的任务总表。当前只列未闭环任务的执行规划（含 Lumen Lite/Deep GI Lite、Nanite Lite、Deep Lights、Shader、切换、Native、Deep2D、Package）见 [`deep-engine-webgpu-remaining-plan-2026-09-14.md`](deep-engine-webgpu-remaining-plan-2026-09-14.md)。

这份专项文档把 `deep-engine-glm-final-handoff-2026-09-14.md`、额度中断前的 Browser 进度和当前工作区实测结果合并成一个可执行基线。历史交接保留原样；本文件只记录复核后的口径。

## 当前结论

- Browser WebGPU 与 Windows native `wgpu` 的核心路径已经可运行，但还不是正式默认引擎切换，也不是完整 Three/编辑器替代品。
- GLM 交接的 40 个原子项：**11 完成、14 部分完成、15 未开始**。原交接中的“23 项交付”“6/6 恢复矩阵”不能直接作为完成分母。
- 当前验证通过：Native `cargo test`（35+30+7+4 等测试组，0 失败；9 个普通 ignored GPU 场景另行通过）、Native clippy/fmt、7 面恢复矩阵、Deep 包 247 个测试文件 / 1842 通过 / 34 跳过、Web typecheck/build、Lab build、仓库门禁与 diff check。
- Windows PowerShell 5.1 的便携包回归曾因 `Path.GetRelativePath`、`Convert.ToHexString` 和 ZIP 清理句柄失败；已补兼容实现与有界清理，`powershell.exe` 和 `pwsh` 两套测试均通过。
- 正式项目已启动并可测试：`http://127.0.0.1:5173`；API `http://127.0.0.1:4100`。启动器当前为 `web` 持续模式，状态为健康。
- 桌面主窗口已切换为无系统装饰 + 深色自绘标题栏，含拖拽、最小化、最大化/还原、关闭；正式桌面构建的 Rust 检查通过。脚本编辑器仍保留独立系统窗口装饰。

## GLM 40 项复核

| 状态 | 项目编号 | 复核结论 |
|---|---|---|
| 完成 | 1, 2, 3, 4, 13, 20, 21, 30, 33, 34, 38 | 动态 RenderPacket、核心 telemetry、动态阴影拟合、clip/image、latest-wins、无效 shadow 更新抑制、BRDF、diff、Deep2D 多子路径/holes、路径 clip 已有代码与测试证据。 |
| 部分 | 5, 6, 7, 8, 9, 11, 14, 19, 23, 28, 29, 31, 32, 35 | 组件或局部链路已存在，但缺少产品级接线、完整维度或真实故障证据。典型例子：native runtime package 没有真正的常驻 prewarm 消费；恢复矩阵没有注入真实 device-loss/交互 resize；Deep2D 缓存没有复用 frame bind group；GPU 预算不含材质/管线/IBL/阴影等全部驻留；DPI 仅覆盖部分档位；dash 已修复大 offset bug，但闭合路径/DPI/预算验收仍缺。 |
| 未开始 | 10, 12, 15, 16, 17, 18, 22, 24, 25, 26, 27, 36, 37, 39, 40 | 独立可复现 perf gate、能力/失败 JSON、renderer executor 常驻复用、自动质量档位、动态 LOD residency、transform fast path、真实相机透明度、Hi-Z history、indirect 扩容、submission retirement、adapter degrade contract、round cap/join、命中测试、完整 DPI rebuild 尚未达到验收条件。 |

### 交接中需要纠正的口径

1. “23 项交付”把 40 项任务、首批审计项和阻塞修补混在一起，不能作为完成数。
2. “6/6 recovery matrix”已过时；当前脚本实际有 7 个 surface，而且仍不等于真实 device loss、最小化/恢复和交互 resize 测试。
3. Runtime Package prewarm 目前是 Browser 侧能力；native 的 `ShaderPackageGpuExecutor` 仍按调用栈创建，不能写成“native 常驻预热”。
4. Telemetry 有 opt-in ring 和 CPU/GPU 分段，但还没有固定 warm-up、adapter/backend/build hash、峰值资源和独立 perf gate JSON。
5. Native package recovery 诊断仍可能带完整用户路径；这不满足“诊断不泄露用户路径”的产品要求。
6. WGSL 错误现在回退到安全材质，避免整帧失败；这是一条明确的降级策略，但必须补 UI/结构化诊断，否则用户会看到“能渲染”却不知道材质被降级。

## Browser 进度审计

已经验证的 Browser 组件包括严格 glTF data URI / texture transform / UV1、动画 TRS+morph cross-fade、sparse accessor、运行时 telemetry、Asset Package 事务存储、shader ABI v3、GI Lite/spot shadow/particles/color grading 等。当前问题不是“没有代码”，而是这些组件尚未全部接入正式 Studio 默认路径，缺少真实产品场景、长时间运行、设备丢失和跨模块性能证据。

因此 WEB-01/02/03/04/05 等应按“组件完成、产品集成部分完成”管理；WEB-06/07/08、WEB-09/10/11/13 仍是下一阶段主线，不把 Lab 的固定场景结果推广为全项目结果。

## 剩余任务与时间

估算按 1 名高级图形工程师全职、当前工作区代码可复用、Windows + Browser 两个平台计算；多人并行可按下表的工作流并行，不能简单按日历相加缩短集成与验收时间。

| 阶段 | 交付内容 | 预计投入 | 目标时间 |
|---|---|---:|---|
| P0 收口 | 修正 15 个未开始项中影响稳定性的项目：perf gate、能力/失败 JSON、native executor、真实 recovery/device-loss、DPI、package path 脱敏；整理交接与提交边界 | 6–9 人日 | 2026-09-15 ~ 09-19 |
| Browser WebGPU Beta | 正式 Studio 默认路径接入、资产/动画/材质/阴影/后处理统一管线、设备降级和长时运行 | 15–25 人日 | 2026-09-22 ~ 10-10 |
| 引擎切换 Beta | Browser WebGPU ↔ Three fallback 的无感切换、事务回滚、真实业务场景和 10k 规模基准 | 20–30 人日 | 2026-10-13 ~ 11-06 |
| Windows Native Viewer | native 资源包、窗口/输入、场景加载、Deep2D、诊断与便携包发布链 | 30–45 人日 | 2026-11-09 ~ 12-18 |
| Native 编辑器能力 | GUI/Chart/Host、编辑器状态同步、发布/恢复、安装器和现场故障恢复 | 45–70 人日 | 2027-01 ~ 2027-03 |
| 产品级替代 | 多项目迁移、性能/稳定性矩阵、资产与插件适配、发布运维 | 3–6 个月（小团队） | 2027 Q2 起 |

### 下一轮执行顺序

1. 先完成 P0 收口，不再扩大“已完成”列表。
2. 把 Browser 组件接入 Studio 正式路径，形成一个可切换、可回滚的 WebGPU Beta。
3. 再做 native viewer 的资源/窗口/诊断链；GUI/Chart/Host 不与渲染核心混写。
4. 每个阶段都要求：单元测试 + 真实 GPU/浏览器证据 + 失败路径 + 2 轮视觉截图 + 可复现报告。

## 当前运行与测试入口

- 正式 Web 工作台：[http://127.0.0.1:5173](http://127.0.0.1:5173)
- API 健康检查：[http://127.0.0.1:4100/health](http://127.0.0.1:4100/health)
- WebGPU 固定场景实验室（专项验收，不代表完整项目）：`http://127.0.0.1:5291`
- 统一状态命令：`pnpm studio status`
- 停止命令：`pnpm studio stop`

当前工作区仍有大量未提交并行改动，未做 reset/clean，也未 push；本文件和兼容性修补应与对应功能切片一起审阅提交。
