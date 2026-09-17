# Native 前向目标预算复核

P1-09 的旧预算漏算深度多重采样。`ForwardTargets::new` 为 HDR resolve 分配单采样 Rgba16Float，为 HDR color 和 Depth24Plus 分配 `FORWARD_SAMPLE_COUNT=4`。

逻辑估算修正为 `8 + (8 + 4) × 4 = 56 B/px`，1280×720 为51,609,600 B。Depth24Plus按4B/采样估算，未计驱动对齐、压缩或物理驻留；不是显存实测。

旧“纯二维与HDR没有像素依赖”也不成立：`OutputPass::draw` 清屏后绘制全屏三角形，输出shader读取HDR并执行ACES及颜色编码；二维层随后叠加。半透明内容、未覆盖区域和letterbox仍依赖底色。后续裁剪必须保留背景与启用的Bloom/Fog语义，并做像素等价对照，不能直接删除输出pass。

本片仅修复诊断估算并使测试实际调用生产计算函数，不改GPU分配和画面。5项content_profile测试、cargo fmt检查、repository gate通过。未执行新GPU像素或浏览器视觉测试，P1-09目标裁剪仍待实现。
