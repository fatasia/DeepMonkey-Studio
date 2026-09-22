# Native 作者 HDR 环境与材质组合（2026-09-18）

作者 Radiance HDR 已接入已有 IBL 预滤、冻结发布与 Native 离线客户端；材质组合使用同一 PBR/阴影管线。

## 实现

- recipe v11 / 环境 v6，能力为 `deep.scene.hdr-environment.v1`、`deep.scene.hdr-lighting.v1`。保留纯色背景和版本化作者灯光；旧包解释不变。
- 复用既有 Radiance 解码、GGX 预滤、漫反射卷积、DFG 和 rgba16float IBL 契约。Native CPU CLI 执行预滤，128 尺寸反射完整 8 mip、32 尺寸漫反射 cube、128 DFG；没有新增渲染框架或依赖。
- 原始 HDR 字节 SHA、源预算、环境强度和预滤内容进入冻结身份。ZIP 改写资源 URL 后通过清单还原源语义再校验；源替换、缺失身份与越界请求拒绝。
- 输入最多 32 MiB / 2,097,152 像素；输出半精度能量不截为 LDR，超过有限半精度范围则拒绝。当前支持 HDR 反射＋纯色背景，不包含全景背景、EXR 或实时 GI。

## 验证

- Web 类型检查与 HDR 专项 2 项、既有编译/冻结/能力 48 项通过；API 类型检查及 56 项候选/依赖测试通过；Node ZIP CLI 90 项、验收脚本类型检查通过。
- CPU HDR 预滤专项 4 项、既有 IBL 契约 9 项通过。真实 HDR 1024×512 预滤保留峰值 524，8 层 mip；常量高动态输入各 mip 保能量。
- 最新 `cargo clippy --bin deep-engine-native --tests -- -D warnings` 通过，包含并行 Deep2D 保存模块的本轮改动。
- RTX 4060 Vulkan 8 组实际读回：HDR、无 IBL、法线关闭、金属粗糙度、遮罩阈值、背面双面、接收关闭、投射关闭。相对基准变化通道数为 `706296 / 79591 / 93629 / 110956 / 50665 / 141902 / 141902`；所有输出有限，零窗口失败替换保留原像素，恢复后有效替换改变结果。
- 矩阵包含 OPAQUE、MASK、单/双面 BLEND 及 baseColor/normal/metalRoughness/AO/emissive 纹理。BLEND 沿用不写投影深度的既有规则；这不是透明透射阴影能力。
- HTTP 12 帧候选→发布→默认/自定义 EXE→停 API 离线启动，6 个窗口客户区逐像素一致。真实 frozen ZIP 经过实际导出与 CLI 校验，9 文件 / 3,273,108 字节，内容 hash `c23f17c503490e9f5cef9f48964a610bb763b45794525c1e4d6670a1d4344a49`。
- 实窗证据 `test-output/scene-hdr-20260918-r2/`：1200×800、963 色、560927 前景像素，客户区 SHA `51da5a1c4823d07bbd109d4a50cb9f237d23a5a87b83cd171feb93093fb83c40`。默认 EXE SHA `27c8543928460f9ed31d633ead08146aff08a67fd4d587f9444e8555b1625809`；自定义 EXE SHA `7b967f267c1e9cffe9eec7baa98413e06b2b87d00bff807898205b4135d68820`。

## 来源与视觉

真实源为 Poly Haven [Studio Small 09](https://polyhaven.com/a/studio_small_09)，作者 Sergej Majboroda，CC0；下载和授权记录见 `test-output/hdr-source-20260918/source.json`。原始 SHA `e7cfda5f4e98e623db12b8bfd0184e048488e4855d9c83e2751fb44a32e80c45`。

按 design-taste-digitaltwin 两轮查看发布前与自定义离线窗口。对标 Unity 的 HDR/PBR 材质语义；高动态摄影棚映射使模型和地面明亮、反射连续，无黑帧或品牌变化。此夹具验证渲染消费，不替代工业场景最终艺术调校。

10 维自评：布局 9、令牌来源 9、既有排版 9、事务状态 9、3D 本档 9、尺寸稳定性 9、语义 9；动效、信息设计、交互时延本档不涉及。HDR 不等同于 GI；真实烘焙 GI 消费另行记录。Engine 总目标尚未全部完成。
