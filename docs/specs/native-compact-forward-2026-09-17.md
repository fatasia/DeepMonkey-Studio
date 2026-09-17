# 纯二维前向目标紧凑分配

纯二维且未启用Bloom、Fog或差分探针时，前向HDR/MSAA/深度目标采用1×1尺寸。窗口、二维画布和最终输出保持原尺寸，源背景继续经过同一ACES与颜色编码；没有删除输出pass或改成黑色清屏。

## 实现与边界

- `ContentProfileReport.compact_forward_targets`记录实际档位，构造与resize共用尺寸选择函数。原有`forward_targets_skippable`只是历史判据，不代表已完全删除目标。
- plain输出shader将采样坐标限制在源纹理范围；完整尺寸路径仍逐像素读取，1×1路径复用同一背景像素。
- Bloom、Fog、探针、三维实例、无二维内容均保持完整分配。默认Bloom开启，因此默认配置不计入本片节省。
- 2D/3D档位变化复用现有完整renderer重建屏障，禁止在紧凑档位增量塞入三维内容。零尺寸仍跳帧，恢复后重新配置窗口。

逻辑目标容量从`width×height×56`降为56B：1280×720从51,609,600B降为56B。该数值仅描述三个纹理的逻辑估算；不代表驱动驻留、整个进程显存或FPS提升。

## 已执行检查

- 六项CPU档位/预算测试通过。Native bin常规125项通过、43项需显式运行的GPU测试默认忽略；clippy通过。
- RTX 4060 Laptop/Vulkan真实窗口：1×1纹理尺寸断言、980×617呈现、零尺寸跳帧、1280×720恢复呈现、2D→3D→2D与非法增量切换拒绝通过；GPU scopes/callbacks clean。
- 独立真实GPU测试两轮通过：Rgba8Unorm/Srgb、五种尺寸、暗/HDR亮/半透明/全透明四种背景共40组，41,032个像素RGBA逐字节一致；六组非均匀棋盘共2,382像素保持正常全尺寸采样坐标。GPU scopes与uncaptured errors为零，专项clippy通过。
- 本报告不将GPU像素或窗口呈现等同于双主题截图验收；全产品视觉、默认Bloom路径裁剪、实际驻留和性能分位数仍未验证。复跑：`cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --test compact_forward_output_gpu -- --ignored --nocapture`。

设计检查沿用Unity式材质/色彩语义及既有界面令牌，本片不新增UI、配色或动效。工程技能用于构造/resize同源、条件否决、恢复与失败边界检查；视觉技能要求的完整十维与两轮浏览器截图不计作本片已完成。
