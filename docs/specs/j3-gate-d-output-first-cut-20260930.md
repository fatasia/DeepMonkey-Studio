# J3 Gate D：输出色彩共同子集首刀

## 现状核查

已有（不重建）：TS `pbrOutputShader.ts`、native `OutputPass`/`compact_forward_output_gpu.rs`、输出家族漂移台账、`scripts/lib/pixelParity.mjs` SSIM、J5 双端门。真实缺口是同输入的跨宿主直接比较入口。native 非中性曝光/分级、雾与 bloom 的语义仍有差异；本刀不以扩大容差掩盖它们。

## 共同合同与消费路径

唯一输入是 `packages/deep-engine/fixtures/display-parity-v1.json`。32×32、8 个 HDR 色块，固定 RGBA16F 输入与 RGBA8 UNORM 输出；生产共同档为曝光 1、Narkowicz ACES、无分级/暗角/雾/bloom。

TS 运行正式 `outputShader`，native 运行正式 `OutputPass`，后者复用既有真实 MSAA clear/resolve 读回函数。native 每色块执行输出 pass，再将色块结果组成比较帧；因此本刀认证色彩输出，不认证非均匀输入的采样坐标、相机或场景空间一致性。C8 的 WGSL/GLSL 库另外比较 RGBA32F 浮点输出，覆盖两种 ACES 与两组非中性分级参数。

运行入口：`node scripts/j3-display-parity.mjs`，亦已登记 J5 GPU 门。一次 runner 执行双方，J5 按命令去重；任一端失败、全黑、非有限、错误尺寸、当前 manifest 不一致或重复不稳定均拦门。每次清除自己生成的旧 native 输出，防止 cargo 过滤器空跑时误用历史文件。

预注册阈值：最大通道差 ≤1/255、最差块 SSIM ≥0.999；库最大浮点误差 ≤2e-5。禁止曝光拟合、重采样或以 SSIM 平均值掩盖局部色偏。

## 真机证据

首轮两次运行：TS/native 最大字节差 **0**、每块 SSIM **1**、重复稳定；C8 库最大浮点差 **1.1920928955078125e-7**，GPU 错误为 0。最终修订后复跑数据见 `test-output/interrupted-0930/display-parity/evidence.json`；native 驱动信息与测试退出码见同目录 `native.log`。

两轮浏览器原始 GPU 像素预览：`web-round-{1,2}.png`、`native-round-{1,2}.png`。视觉检查确认 8 色块正确，暗部、HDR 高光与彩色区均有有效输出。对标引用为 [Three.js TSL](https://threejs.org/tsl/) 的后端一致性思想；本刀的渲染一致性自评 9/10，仅限此共同输出档。十维中的布局、设计令牌、排版、产品状态、动效、信息设计、反馈、响应式/主题、产品文案均不适用，因为未增加产品界面；完整产品画质仍须 Z2/Z4 两轮场景验收。

## 剩余范围

- Gate D 全门还缺同一 Runtime Package 整场景的线性 HDR、深度/阴影/法线与相机质量合同对拍。
- native 非中性曝光/分级、bloom/雾、SSR/TAA 单独登记差异，不能从本首刀推断已对齐。
- Gate E GPU 显存、device lost、首帧延迟不由此门认证。
- 未测帧时收益。本刀运行时着色器字节不变，离线对拍不进入帧循环。
