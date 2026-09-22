# DE26 A04/A08：真实资产成对采样

本片给 Deep / Three WebGPU 基准接入完整资产、冻结轨迹和原始通道差距；不是 DE26 全部结项。

## 结果

所有数值为五轮每轮 P95 的中位数，单位 ms。候选为 Deep，参考为 Three 0.185.1 WebGPU。

| 资产 | CPU Deep / Three | GPU Deep / Three | 感知相似度 | 冻结门禁 |
|---|---:|---:|---:|---|
| 本机预热机 | 0.700 / 4.200 | 0.065536 / 0.393216 | 0.99395 | 通过 |
| 本机 BIM 烘焙场景 | 0.800 / 7.000 | 0.327680 / 1.179648 | 0.98703 | 通过 |
| Box ×1024（早期同轨迹） | 0.300 / 0.200 | 0.131072 / 0.131072 | 0.99840 | 未达性能标准 |
| NormalTangentTest ×1024（早期同轨迹） | 0.300 / 0.200 | 见原始记录 | 0.9832 | 未达性能标准 |

预热机/BIM 机器证据：`test-output/deep-engine/webgpu-1789697180878.json`、`webgpu-1789697231590.json`。
两份共同 build SHA-256：`acf1647203c241abf4e4ba6eefa80db69f63a7cf343ebb37f7b9f7261419c5c0`。
拆分与灯光预算修复后的 BIM 五轮复测：`webgpu-1789698341411.json`，build SHA `7fb208e348fd5dd823e48c0c1769d4c67e9a1d36735af7ad8f1f946b654bb534`；CPU 1.100 / 9.000 ms、GPU 0.327680 / 0.983040 ms、相似度 0.98703，冻结门禁通过。该次机器负载不同，不用两次绝对延迟变化宣称优化。
早期 Box/NormalTangentTest 证据：`webgpu-1789696164334.json` / `webgpu-1789696557127.json`，不是同一最终构建，不混入真实资产的成对统计。

条件：960×540、DPR 1、Baseline 等价、冻结 `fixture.appearance.orbit-360`，5 轮交错 A/B；每轮 20 预热帧、90 CPU 样本、15 GPU 样本。GPU 为逐帧串行时间戳，观察到 0.065536 ms 量化粒度；这些数字不是屏幕呈现时间或整体交互延迟。CPU 差距 bootstrap 95% 区间：预热机 −4.18～−3.04，BIM −6.64～−5.80 ms。相似度是冻结边缘 ROI 加权感知度量，不是 SSIM。

## 资产与公平性

- 预热机：204 几何、213 实例、5 材质、5 纹理；BIM：651 几何/实例、21 材质。两端提交完整相同实例集；未按引擎删减模型。
- 原始本机文件 SHA：预热机 `3ae7527b6d171355cb7237072959397ab7da3f271d5c764269949caed0092073`；BIM `b7eaaaf876a51636fb863dbaa58c8dbc5ee68b25e5ef0dbe184727d87d0d3c95`。
- 测试派生仅用已有固定版 glTF-Transform/Draco 解压与 dequantize；保留作者变换/材质。预热机派生 SHA `aee52d8ef3885d9237311366bf19e8850773a9f862a39c213450d658da55807a`；BIM `2c29212478dfbd73ff816085b0aa4d59ab9fd0282df91459a671c60af6ae5112`。
- 预热机原文件存在远离主体的节点，全景半径 2813；最终相机按源文件 authored `group2` 设备装配的中心/半径 31.19 定位。完整 213 实例仍在包与两端场景内，cameraFrame 和 contentPolicy 纳入 fixture hash。该结果是设备聚焦轨迹，不是完整场景所有对象同时可见的测试。
- 每轮保存真实 drawCalls/triangles/resources。没有 GPU 可见对象计数，drawCalls 不等于可见对象数量。第一轮末帧预热机 Deep/Three draws=410/204、triangles=66633/33314；BIM=1187/771、346290/182620；多 pass/阴影计数口径不同，不作为几何删减判断。

早期 `webgpu-1789696695153.json` 的预热机全景相机把设备缩成极小点，仅地平线便通过旧细节门禁；该记录不作为通过证据。现有双向边缘门禁及背景/地平线/微小主体负例覆盖此回归。

## 实现

Three adapter 支持完整多几何/多材质/纹理/UV/tangent/color/镜像变换；未知压缩纹理、未接姿态/LOD 明确拒绝。原先只取首几何和固定材质的路径已移除。两端重放同一相机轨迹；选择/剖切动作仍拒绝，不假定已实现。

原始 CPU/GPU 样本进入 A03 schema 和五轮配对报告，另外六个通道明确 unavailable。资源指纹先对二进制流逐个 SHA，再序列化元信息，修复大纹理 `Invalid string length`。实际多资源运行还定位并修复 MRT pipeline 无 `displayMain` 时错误走 direct-display 的问题。

额外正确性修复：`maxLocalLights` 分支现在用临时评分代理选择原 World 灯对象，保留位置、方向、阴影 key/importance；旧代码将 View 灯强转 World 会导致后续转换缺字段。主 PbrRenderer 当前未传预算选项，故本次性能数据不受此后续修复影响。

## 验证与视觉复核

Deep 最终全量：389 文件、3193 passed / 41 skipped；脚本 27 测试及 runtime purity 通过。灯光 3 文件 23 测试、帧计划/direct-display/灯光 3 文件 35 测试通过。Deep typecheck、build、Native cargo check/build 通过。

Deep 专属 300 行门禁与根 800 行门禁不同：根门禁由总任务核验；本片将 PbrRenderer 启动和帧回执按职责拆分，专属门禁 blocking 从 34 降至 32，其余 Native 超长旧债仍由门禁报告，不据此改阈值。

## Atlas 与真实升级回滚链

`scripts/verify-dashboard-upgrade-rollback-chain.mts` 原来把源包冻结图集数与运行时动态图表标签生成数直接比较。现在 `DEEP_ENGINE_ATLAS_EVIDENCE=1` 才记录 prepared 解码像素 SHA-256/尺寸/格式/采样；正常生产不计算这些验收哈希。断言对每张冻结图集做唯一匹配，再核对 prepared 总字节、批次和顶点证据。

真实当前 Debug 构建完整运行 `test-output/p03-05-atlas-semantic-20260918/evidence.json`：17 steps、11 截图，EXE v2/v3 都是 3 frozen + 13 generated = 16 prepared，3 张冻结源像素逐张匹配。HTTP 取消、坏 hash/schema GPU 前拒绝、EXE 回滚逐区域像素完全一致、文件坏包 LKG 恢复、缺资源 fail-closed、解包门禁、服务全关离线旧版启动均过。辅助断言 2 测试、Native atlas 8 测试和验收脚本 typecheck 通过。

视觉复核 `screenshots/exe-v2.png` / `exe-v3-valid.png`：中文标题、柱图、单位、背景变化正确；KPI/筛选/table 区域仍主要是空面板。这份 17-step 证据证明升级恢复链，不证明这些组件完整视觉交付。此缺项已交总任务跟进。

空白组件追查：部署测量入口只允许 bar/line/scatter/pie，遗漏已经存在的 value/table lowering；fixture 还遗漏 table 字体绑定。补齐后 `test-output/dashboard-measured-recovery-20260918-r2/round-1.png` / `round-2.png` 实窗显示 KPI“总有功功率 91 MW”。表格仍 fail-closed：生产 Web capture 已含 CSV/Excel `tool` 角色，冻结文本语义映射遗漏两角色；精确诊断见 `dashboard-measured-recovery-20260918-r3/role-diagnosis.json`。此处由总任务补同族合同，恢复脚本已要求 KPI/table 不得 blocked，仍须保留 interaction deferred。

filter 的文字和运行行为是两处缺口。Web 已有 `dashboardFilterHitCommand` / `dispatchDashboardFilterHit`，保留节点/key、父参数、输入键、16 选项白名单并调用既有 playback store；Native `DashboardRuntime::pointer` 对非 chart 命中直接返回，包内没有冻结 dataset/filter 状态。最短后续是保留冻结行与滤项关联、接现有白名单和过滤语义、复用 `apply_data → transaction → rebuild → present` 原子更新图表，并验证点击前后数据和像素、非法命中不变。仅编译选项字形不能结项筛选能力。

空间告急时仅清理本轮验收生成的四个重复 EXE；原 Debug EXE、运行包、哈希清单、日志与全部截图保留。后续恢复脚本复用原对象库/字体/EXE，避免重复复制。

用户指出文字发虚后实测：`dashboard-measured-recovery-20260918-r3/dpi-diagnosis.json` 与 `dpi-diagnostic-4.png`，客户区 1200×800、DPI 120（125%），960×540 逻辑画布 aspect-fit 为 1.25 倍。标题 886×38、KPI 数字 48×58 都是 1x 字形图集，以 linear 采样放大；动态轴标签也按逻辑字号生成，未接物理密度。这是当前清晰度缺陷，不能因读得出文字而视为通过。诊断期间两次 18×18 空客户区截图排除；截图工具现选择指定进程最大可见窗口并拒绝空客户区，记录实际 DPI。

静态修复将 `textRasterScale` 纳入编译配置/源语义/请求身份，库保留 1x 兼容默认，正式 compiler 默认 2x。Native producer 从冻结字体重新以双倍字号/行高/物理尺寸栅格，不插值已有 bitmap；quad、clip 仍用原逻辑尺寸。按钮按物理密度重画圆角/边框后统一 opacity，保留分数逻辑宽高的透明取整余量，验收按同一密度重放 producer 像素与冻结配方。8192 边长和 64 MiB 预算按物理像素执行。

真实字体生产检查 `test-output/dashboard-text-layout-density-20260918/evidence.json`：8 次 Native 调用，中文 3 行、混排 3 行、显式换行 3 行、窄英文 4 行，含 fractional 宽高；1x/2x 的 baseline/top/height/width 除密度后误差 <0.001，clipped 相同。定向测试覆盖文字/按钮逻辑几何不变、密度篡改拒绝、物理超限拒绝；Web 与验收脚本 typecheck 通过。实际窗口多倍率清晰度仍待本轮截图复核，动态轴字形由 Deep2D 线独立处理。

按 design-taste-digitaltwin 的两轮截图流程，第一轮发现 980 宽度控件换行、英文结论溢出和预热机极小主体；第二轮控件换行/中文结果修复，BIM 建筑及植被、预热机主体和两端一致性均可见。截图见本任务浏览器记录。实验室保持现有 base.css token，不增加影响公平性的新 Bloom/雾等效果。

对标沿用工作区五家基线：Unity 的材质/光照语义、Siemens 的单位/结果密度、FVS 自适应纪律；本片没有证明 Unity GI/多灯/阴影能力对齐。实验室十维自评（信息层级、字体、间距、配色、布局、交互反馈、响应式、3D取景、渲染一致性、证据可复现性）为 9/9/9/9/9/9/9/9/9/9；这不是产品场景 Kimi-95 全面验收。

## 剩余

Babylon/Unity 真正参考 adapter、六个未测通道、选择/剖切轨迹、低噪声小场景 CPU 优化尚未完成。A04/A08 仅本片 CPU/GPU 相机轨迹范围成立。拆分与灯光预算边界修复后已复测 BIM；预热机仍引用其冻结构建，不外推到后续构建。
