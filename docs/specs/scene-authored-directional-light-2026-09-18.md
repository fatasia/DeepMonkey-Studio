# Native 作者方向光交付（2026-09-18）

原 Engine 主线新增单方向光的正式编译、冻结与 Native 消费；不是多灯/GI 完整目标的替代品。

## 能力与兼容

- 明确纯色、无网格、无天空盒/HDR 档，`reflectionsEnabled=false`、`globalIlluminationEnabled=false`，一个显式方向光。消费开关、颜色、全局/单灯强度、世界位置→目标方向、灯光阴影开关；未支持类型、多个灯、GI/反射开启、未知字段继续阻断。
- 曝光按 Web `enabled ? clamp(0.72 + intensity * 0.33, 0.55, 1.55) : 0.55`，sRGB 灯颜色转线性后乘两级强度。曝光作用于物体而非作者纯色背景。非晴天不声明支持；作者天气字段仍受原门禁约束。
- recipe v7、环境 payload v2 与 `native-aces-light-v2` 显式区分旧包。Frame v2 在旧 208 字节后追加到 240 字节，旧成员偏移与旧包照明分支保留；旧 ShaderPackage 真实 GPU 热更通过。旧自定义 ShaderPackage 不支持新作者光时拒绝，不假报支持。
- 方向同时送入 PBR 和 CSM；相机旋转/resize 不旋转世界灯。灯光变更及跨 Bloom/Fog 档复用完整候选渲染器事务，呈现成功才提交。

## 实际发现并修复

阴影接收差分发现 Native `VertexOutput.material` 内含 bit flags 却被默认插值，转 `u32` 截断会丢失 `receiveShadow` 位。参考已有 Web `pbrShader.ts`，改为 `@interpolate(flat)`；没有修改差分阈值。关闭模型接收阴影和关闭灯阴影的 3511 个通道差异变为 **逐像素相同**。

## 验证

- Web 类型检查及 46 个编译/冻结/能力针对测试通过；Native CLI 79 项通过，包含反复重绑 hash 后篡改 radiance/exposure/direction/shadows 的拒绝。
- Native frame ABI 4 项、灯光纯逻辑 1 项；真实 GPU 覆盖旧 Bloom+Fog→纯色→恢复、失败保留旧帧、灯光强度/方向/阴影像素差分、相机/resize 同源方向。强度改变 41597 通道、方向改变 47111、阴影改变 4824；模型关闭阴影接收与关闭灯阴影逐像素一致。
- 全量目标范围 `cargo clippy --bin deep-engine-native --tests -- -D warnings` 通过；API 48 项候选编译/服务/依赖存储专项通过。
- HTTP 候选真实 12 帧→正式发布→默认/品牌 EXE 下载→停 API 无参数启动；发布前两轮及下载后四轮共六张 1200×800 客户区完全一致。首轮真实发布暴露持久化能力白名单遗漏，补齐后 r2 通过。
- 证据：`test-output/scene-directional-light-20260918-r2/{evidence,pixel-evidence,candidate-window,dependencies}.json`。EXE SHA `967c1dec1fc08a2bd767336db5859bd0731fef3a1e437d3c566666b1dbf9af23`；客户区 RGBA SHA `0f9579aff7e6e1f20fd1d0b6882bc0d332a50b8279e17b0d60506bb236dede8b`，41 种颜色、128444 前景像素，背景精确 `#172126`。

## 视觉复核与剩余

参照 Unity 作者灯光/阴影语义，工程实现参考已有 Three/Web Deep。两轮真实 Native 截图证明色面/主体/背景完整；这是原生程序，未改浏览器 UI，未作为整个平台浏览器视觉验收。

10 维度：布局 9、作者令牌一致性 9、既有标题排版 9、事务状态 9、动效不涉及、3D 9（仅方向光/阴影这一档，不代表 Unity 全画质）、信息设计不涉及、反馈耗时未测、两档尺寸 9（未新增主题 UI）、语义 9。三套正式场景、完整画质对标和反馈时延仍待验收。

剩余：多灯、点/聚光/面光、GI、反射 HDR、完整作者后处理、所有材质与阴影组合、Web/Native 同场景绝对像素比较。不能把单 Box 和一个 GPU fixture 的结果扩大为任意项目画质承诺。
