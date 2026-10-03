# bim-studio 交接文档：剩余任务全景与执行指引（2026-10-04）

> 交接时点：61 行主表 **58/61 关闭（95.1%）**，剩余 3 行 + 全仓遗漏排查坐实的 26 项行外遗漏 + 用户 7 条实测反馈的执行面。
> 本文档是唯一交接入口；细节证据索引在文末。**所有结论均有文件：行或账本出处，无臆测项。**

---

## 一、P0：环境解锁（一项用户级操作，解锁三条线）

**OrayIddDriver Device（向日葵虚拟显示）占 GPU 适配器首位且不支持 D3D12**，导致：
- Chrome/Worker 的 WebGPU 与 D3D12 初始化全灭（编辑器切 Deep 失败、发布 Native 报 Bad Gateway、页面卡顿降级软件渲染）；
- 所有 GPU 验证自动化（Playwright/CDP）无法拿到 WebGPU（Chrome 154 headless 常驻+CDP 形态下 renderer 侧 WebGPU 绑定缺失，与 OrayIdd 叠加；诊断终章见账本一百零六）。

**解锁命令（管理员 PowerShell）**：
```powershell
Get-PnpDevice -FriendlyName "OrayIddDriver Device" | Disable-PnpDevice -Confirm:$false
```
（或设备管理器→显示适配器→OrayIddDriver Device→右键禁用。完全可逆：`Enable-PnpDevice` 同参恢复。用户确认本机显示器走 NVIDIA 物理输出，禁用不影响本机使用；仅向日葵"被控端虚拟桌面"功能暂不可用。）

解锁后按 §四队列自动/手动执行批次 1。

## 二、剩余 3 行（61 行表内，全归批次 1：GPU 窗口）

| 行 | 内容 | 前置 |
|---|---|---|
| B2/T11 | 冻结树 A/A+A/B 冷暖切、输入 P95/P99、有效首帧、20 次进出内存；未达按瓶颈补优化 | GPU 独占窗 |
| J3-E-GPU | 帧时定标+≥5 成对统计（独占 GPU 批） | 前置门：J3-E probe §6.3 对拍（12 收据/4 HDR 行 drift 0/frame-8 双侧/drifted=[]；回移植已完成、新 SHA ce05fd52 已入账，看门狗探窗中；**通过前统计批维持禁跑**） |
| Z2/Z3.5 | 默认档真机验证与回退 + 自适应档 softness knob 扩展（quality 档映射 0.35/performance 档 0；性能合同优先已裁决，见账本九十八） | GPU 独占窗 + softness knob 实现（CPU 可先做） |

另有 texture-coverage（j3D 层）evidence.json 缺失（lab/j3DFullLayerMatrix.test 红）——属 GPU 域真机验证层，归批次 1。

## 三、批次 2：行外遗漏执行表（omission-audit-20261004.md 完整清单）

**五类定性**：行内已闭 23 / 行内挂起-GPU 3 / 行内挂起-拍板 7 / **行外遗漏 26** / 建议不做 12+。
**重大发现**：10-01 两份深度审计拆出的 32 条任务行从未进 61 行表；4 项疑似错误关闭已坐实（同"把 CPU 参考文件存在当消费闭环"误判族）。

**建议处置顺序**（按用户价值与依赖）：
1. **T20 GPU 粒子渲染消费族**（排序核/曲线 LUT/火焰接线/事件读回，24-48h）——疑似错误关闭，今日复验仍缺；
2. **T14 根运动族**（旋转应用/UI 开关/导入版本验证）——viewerEngineRootMotion.ts:25 注释在案；
3. **T12 交付悬空族**（assetDeletionImpact/detectStaleAssetRevisions/DeepAssetReimportCoordinator 三套零消费方）；
4. **T24 backfill**（OPC UA Historical Access）+ 数据质量视图——"活数据命脉"级缺口；
5. **T08/T09 六工作包**（aniso/transmission IBL、SSS、毛发、体积云、水面、多灯雾，44-64h）；
6. **D3 差分更新/签名/可回滚发布**——8 项工业关键缺口中唯一无承接项；
7. **outline 引擎专批**（账本收 bit256+WGSL pass）；
8. **场景编译器 materialLosses 传播**（场景级导入损失可见性）；
9. **T17 collider 来源选择器 UI+跨端容差冻结**；
10. **J3-E 残项**：lost reason 排障保真小批+animation-policy/camera-constraints 引擎 API 设计批。
其余 16 项见 omission-audit §2 各表（均带文件:行出处）。

## 四、用户 7 条实测反馈的执行状态（2026-10-04 白天）

| # | 反馈 | 状态 |
|---|---|---|
| 1 | 发布 Native Bad Gateway | 根因=GPU Worker 创建会话失败 502（cloudRenderControl.ts:251）——**P0 OrayIdd 解锁后复验** |
| 2 | 默认 Deep 引擎 | 默认逻辑正确（WebGPU 可用即 Deep），同 P0 根因 |
| 3 | 默认本体样例 | **部分落地**：数据中心内置样例已交付（datacenter-builtin-sample-20261004.md，幂等一键装载设备遥测数据集）；**场景画布默认本体样例正在实现**（sceneCreationAction 注入点已定位：models/primitives 空数组处注入轻量示例——底座+立柱+示例行为，contract 契约已核对，**下一步=写注入代码**） |
| 4 | AI 助手交互复杂/页面乱 | 子智能体执行中（限额中断，14:32 重置后 resume——prompt 已备于本文档 §六） |
| 5 | 编辑器卡顿 | 大概率 OrayIdd 软渲染兜底（同 P0）；解锁后复测，若仍卡按帧时定位。**今晚已修一实锤**：Deep 轨道相机 upBasis 手性相反致水平拖拽反向（deepCameraController.ts upBasis 改 up×basis 对齐 Three 语义，viewer 域 2235 过） |
| 6 | 做好所有遗漏任务 | 批次 2 执行表已组建（本文档 §三），按序派发 |
| 7 | 底层全接入+极致性能 | 接入面审计已含在 omission-audit；性能极致=批次 1 帧时批+批次 2 性能项；对标优化阶段六批次已规划（optimization-phase-plan-20261003.md） |

## 五、已知技术债（在册未清，按影响排序）

1. lighting WGSL 域 cargo test 4 败（3× deepAreaLightData 未定义+1× IES checksum）——native 合成模板引用未注入定义，需 cargo 线考古；
2. ts.worker 双份 6.6M——vite alias 为 pnpm worker 解析必需（删除构建失败实证），根治=monaco esm 细粒度 import 重构（三方案实验收口见账本一百零二）；
3. sceneCompiler 不传播 materialLosses（=批次 2 第 8 项）；
4. gate-online-flow.mjs 旧选择器与当前 UI 脱节；
5. J3-E 候选销毁上报丢 destroyed 根因（=批次 2 第 10 项）；
6. applyTexture 超集 RENDER_ATTACHMENT flag（超集分配非缺陷）；
7. studio 编排器韧性：桌面组件退出（exit 0）不应连带清理 web/api 服务（"启动总失败"的根因，用户自启动指引已给：分组件 `pnpm studio start api` + `start web`）。

## 六、在跑/待重派子智能体

| 线 | 状态 | 重派要点 |
|---|---|---|
| AI UX 简化 | 限额中断，14:32 重置后 resume（SendMessage agent_a361ac45…） | 原 prompt 全在案（AI UX 做减法+设计闭环+组件测试） |
| 默认样例场景 | 同上（agent_c1bbc39a…）——**主线程已接手画布默认本体部分**，重派时聚焦数据中心语义模型 tab 扩展（可选） | 见 datacenter-builtin-sample-20261004.md |
| 批次 2 首刀 T20 | 未派 | prompt 骨架：现状核查六步→消费族缺口实现（排序核/曲线 LUT/接线/读回）→物理域回归 |
| J3-E probe 看门狗 | 探窗中（预算至 12:15），耗尽后 `explorer C:\Users\rain\AppData\Local\Temp\j3-watchdog-launch.cmd` 重启 | §6.3 门=12 收据/4 HDR 行 drift 0/frame-8 双侧/drifted=[] |

## 七、工作区状态

- 未提交改动约 804 项（含全部今日产出与历史批次在库产出）——**commit/push 仍按纪律待用户指令**；
- 服务运行方式：用户自启动（分组件 `pnpm studio start api` + `start web`；OBJECT_STORE=local）；或 `pnpm studio start`（注意桌面组件退出会连带清理——编排器韧性待修，见 §五.7）；
- deep-engine 全量：5979/6032（2 红=j3D texture-coverage[批次 1]+ies 镜像[已修复待验证]）；apps/web 全量：5543/5549；webgpu 域 1829 过 0 红。

## 八、证据索引

- 账本：docs/specs/jc-i-continuation-20261001.md（追加一~一百零六）
- 61 行终版：docs/specs/61-row-final-status-20261004.md
- 遗漏全景：docs/specs/omission-audit-20261004.md
- 优化规划：docs/specs/optimization-phase-plan-20261003.md
- 机器可读行状态：test-output/progress-audit-20261002/61-row-status.json
- GPU 诊断终章与环境记录：账本一百零六 + j3e-probe-backport §6.2/6.3
