# Native 作者纯色环境交付（2026-09-18）

SceneSnapshot 的纯色背景现可进入正式 Native 发布包，不再只保留在作者 JSON 中。本项推进原 Engine 作者字段消费，不计入 DE26 新增强。

## 已完成

- profile 为 `skybox=none`、无外部 HDR、`gridVisible=false`、`#RRGGBB` 背景。Web `viewerEngineEnvironment.ts` 此时 `scene.environment=null`；Native 复用既有零 IBL 资源，不关闭独立 GI 或灯光字段。
- 编译 recipe v6 将环境资源实际 SHA 纳入 compileGraphHash；能力证据必须指向实际字段，旧 v5 不允许自报环境支持。运行包 schema 仍沿用既有版本，不与实验 X 的 schema v6 混淆。
- 原有 ACES 输出前反解作者 sRGB，背景在既有 HDR/MSAA 目标清屏；初载、resize、同档换包及失败回滚均携带背景。旧包保留默认 IBL、背景和 Bloom。
- 未支持天空盒、HDR、网格、额外环境字段仍 blocked；独立 lighting/GI 仍按原能力报告处理。该 profile 默认不启用 Bloom，显式 Bloom/Fog 不兼容配置拒绝，避免输出色漂移。

## 验证

- Web 编译/冻结针对测试 37 项、Deep Engine 合同测试 1 项（含非法字段/颜色/版本反例）、Web 类型检查通过。
- Rust 解码 2 项通过：全部 256 个 sRGB 字节数学往返及非法身份/字段/范围拒绝。Native 2 项通过，包含真实 RTX 4060 Vulkan 窗口 GPU 测试；初载、640×480→800×600 resize、替换颜色、0 尺寸拒绝保留 LKG、恢复和旧包默认行为均覆盖。
- 当前部署编译器→真实 HTTP 候选 12 帧→发布→默认/自定义品牌 EXE 下载→停 API→无参数启动。发布前两轮、下载后两种 EXE 各两轮共 6 张 1200×800 客户区，55 种颜色、128444 个非背景像素，背景为 `#172126`，六张原始 RGBA 完全相同。
- 证据：`test-output/scene-solid-environment-20260918/{evidence,pixel-evidence,candidate-window}.json`。客户区 SHA-256：`eb892c4ca9b343d6cac94db09d83ece20ae2ac9cf541d1ac15620191a0c8a3ac`；EXE SHA：`3e0678fe59ddc30c1fe3114fe6718aa589c72ef4af304a27739dab7fad8ddb33`。

## 视觉验收与边界

设计参照 Unity 的作者背景与输出变换分离、山海鲸的深冷灰场景底色；测试采用既有 surface-2 色值，不新增 UI 令牌。两轮真实 Native 窗口已采集，未修改浏览器页面，浏览器视觉闭环不作为本项已完成证据。

10 维复核：布局构图 9（主体完整居中）；令牌一致性 9（作者色精确保持）；排版 9（既有窗口标题）；状态 9（失败保留旧帧）；动效不涉及；3D 完整画质未验收（仅背景/IBL profile，单 Box 不能支持 Unity 整体画质结论）；信息设计不涉及；反馈速度未测；响应式 9（GPU 两档尺寸），双主题 UI 不涉及；语义 9（未支持项拒绝）。不把这份局部验收计为整个产品 Kimi-95 完成。

同日已补跨输出档迁移：初载/设备恢复、文件拖入及热更新按内容选择有效配置；档位变化复用完整候选渲染器事务，纯色档关闭 Bloom/Fog，宿主设置保留，退回旧档恢复。真实 GPU 验证 Bloom+Fog→纯色→旧档恢复，0 尺寸拒绝时旧帧像素不变；既有 full-package present 专项（跳帧、抢占、恢复）通过。底层未经档位重建的直接替换仍拒绝不兼容配置，防止旁路。

纹理天空盒、HDR、网格、独立作者灯光、作者后处理和交互仍归原 Engine 剩余项，不能以本例替代。上述 6 张发布像素为此前生产 EXE；跨档变更另以真实 GPU 事务测试验收，不混称同一 EXE。
