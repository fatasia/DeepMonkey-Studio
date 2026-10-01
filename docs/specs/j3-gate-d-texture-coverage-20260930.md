# J3 Gate D：共同纹理、UV 与 alpha 覆盖

本切片验证同一个 runtime 包的正式 Native/WebGPU 实际帧，不增加渲染器。原 `j3-hdr-flat-normal-v1` 的 85 点、两个相机、四个实例和镜像三角形身份保留。

## 现状核查

1. 全仓关键词与未跟踪文件：Native `pbr_textures`、`alpha_pipeline`、`c8_unlit_lighting_skip` 已存在；Web `realAssetPixelAnalysis`、baseColor/UV 探针已存在。当前 B5 actual 叶、I layered materials 与 J3 观察接缝由其它线路独占。
2. 契约：`renderPacketTypes` 已定义 UV0/1、每槽 offset/scale/rotation、texture semantic、OPAQUE/MASK/BLEND；Native 同合同严格验证。无需新类型或第二材料协议。
3. 依赖：现有 wgpu、serde_json、esbuild、Vitest、Playwright 已够用，无新增依赖。
4. 消费：两端生产 sampleSurface/shade_native_mesh 真实采样 baseColor/emissive sRGB 与 MR linear；Native 4x MSAA、排序 alpha；Web 单样本 opaque 和 Weighted OIT。单个非重叠透明层才是本轮共同语义。Web 必须读 `transparency.currentColor`，不能把 opaque HDR 当最终透明输出。
5. 测试与证据：旧 CPU 已覆盖编码、UV 合同与 alpha flag；Native UNLIT 实帧覆盖单纹素颜色/MASK/BLEND。旧 Gate D 平面 HDR 与 normal/shadow 有实际帧，但没有共同非均匀纹理矩阵。它们不重跑。
6. 规格：参考 `j3-gate-d-hdr-flat-normal`、normal/shadow、geometry/depth 规格和 0930 handoff。保留原 85 点矩阵，不修改已有光照、设备与 FrameObservation。

**已有（不重建）**：runtime 哈希/验证、材质上传、UV 变换、sRGB/linear 纹理格式、实际 HDR/normal 附件、相机、原 85 点、正式 shader factory 和运行器工具栈。

**真实缺口**：同 runtime 包的非均匀 texel 选择、UV1 全变换、MR 线性实际粗糙度/直射响应、MASK 孔洞与单层 BLEND 最终 HDR 的跨端证据。

## 冻结输入与判据（GPU 前登记）

- 128×128 数值附件，原两个相机，四实例和原 85 点。每宿主两 fresh device，每配置两次正式 draw。截图仅深色 1920×1080，两轮。
- 2×2 nearest/clamp 非均匀自制纹理。UV0 与 UV1 均逐顶点明确给定；UV1 槽同时包含 scale、rotation、offset。材料 factor、alpha cutoff、纹理字节全部写入 fixture。共同包由已有 runtime canonical 哈希及验证器重算；两端消费同一派生包。
- base UV0、base UV1、emissive UV1、MR linear、MR zero-metal 控制、MASK、单层 BLEND 七配置。UNLIT 仅隔离 base 颜色；emissive 正贡献用正式 PBR 关灯，MR 使用正式非零直射和同 constant DFG，不以黑帧通过。
- 原 85 点全部记录。nearest texel 边界附近仅由 GPU 前 CPU 几何/UV 计划排除严格 RGB 判据；每相机每配置至少 12 个稳定点、总计至少 32。稳定点须中心与实际像素四角/边中点（±0.5 pixel）命中同实例/纹素，覆盖 Native 4x sample 的子像素范围，不能按实测结果删点。
- 稳定点实际 HDR RGB：独立 sRGB 分段解码与 alpha-over 期望绝对差 ≤0.002；同语义跨端 HDR RGB ≤0.002。MR 的实际 normal MRT alpha 与 linear G×roughness 期望差 ≤1/255+0.00001；MR B 相对 zero-metal 控制必须至少 16 稳定点有 >0.002 实际贡献差。
- OPAQUE/BLEND 输出 alpha=1；MASK 稳定点逐点接受/拒绝与 CPU texel alpha 判据一致。全帧 foreground mask 差只允许两端真实轮廓同时 1px 内；任何 2px 失配失败。背景固定 Native 默认线性 RGB `[0.012,0.020,0.035]`，Web 取同值。
- 两次 draw 与两 fresh 的整幅 HDR/normal hash 均保持稳定；实际 source、派生包、packet、纹理字节、相机 VP 和执行配置身份写收据。非有限、空帧、无正贡献、缺矩阵、未知 schema、旧 native 文件和筛空 Cargo 都失败。

## 范围

本轮不认证重叠透明层排序与 OIT 一致、线性滤波/mips/各向异性、normal mapping、layered materials、纹理数组、RT 或驱动 loss。MR 只认证冻结光照/constant DFG 的共同路径，不代替完整材质族。

## 验证记录

CPU 与 GPU 待实现后分别回填；Native 注册和实际运行由主线程串行负责。

CPU 侧收口(2026-09-30):

- Native 叶 `j3_actual_texture_uv_coverage` 已按 B5 同族方式注册到 `packages/deep-engine-native/tests/gpu_shader_material_draw.rs`(`support/j3_texture_coverage.rs`;函数签名与 `FrameObservation`/`render_with_frame_observation`/`resolved_normal_texture`/`half_decode` 依赖已逐一静态核对,编译与实际运行由主线程串行负责)。
- runner `--prepare` 现在检测旧 `evidence.json` 的 `inputHash`:mismatch 或不可读即失效删除(`invalidated-stale-input`/`invalidated-unreadable`),同输入则保留并注明;已实测 stale 分支与幂等重跑。`--compare` 与正式 fresh 双宿主路径仍无条件拒绝旧证据(host 级 `inputHash`/`profileHash` 校验)。
- Web `blend` 读 `transparency.currentColor` 的最终合成 HDR 而非 opaque `targets.hdrTexture`,并以同纹理守卫显式拒绝回退;mask 全帧差异仅允许两端真实轮廓 1px 内(内部孤立失配判 FAIL),覆盖「非重叠单层共同子集」语义。
- CPU 稳定域实测并冻结:`base-uv1` 轴向相机 25、斜视相机 19(规格声明值),两相机 stable 子集各覆盖全部 4 texel,已从 ">=12" 弱断言收紧为精确断言;85 点与七派生包哈希唯一性通过。
- 验证命令与结果:`tsc --noEmit -p tsconfig.lab.json`(J3 相关 0 错;`lab/j2ProbeGiAnisoFixture.ts` 存在 3 个属于其它未提交组的既有类型错误,不属本切片)、`vitest run lab/j3TextureCoverageFixture.test.ts` 4/4 PASS、`node --test scripts/lib/j3TextureCoverageParity.test.mjs` 8/8 PASS(过期证据/输入哈希不匹配/0.002 门超差/roughness 门/mask 双向对照/1px 允许与 2px 失配/native 命名运行门全部负例)、`node scripts/j3-texture-coverage-parity.mjs --prepare` PASS(inputHash `9caf585e…`,28 帧/fresh)。
- GPU 侧(两 fresh device 双宿主、Native 实际帧、对拍与 evidence 落盘)未执行,由主线程串行负责。

GPU 前 fixture 开发修订：首稿 UV1 的 3×3 邻居稳定子集全落 texel2，缺少 alpha reject 与多纹素覆盖。没有执行 GPU。改成四角/边中点子像素稳定域，并固定 UV1 scale `[1.2,1.2]`、offset `[0.1,-0.4]`、rotation `0.23`；CPU 轴向 25、斜视 19 稳定点，两相机各覆盖全部四 texel。HDR/覆盖阈值和原 85 点保持。

## 2026-10-01 深夜归因更新（mr-linear）

超差全部限定 texel 2/3（第二行，16/45 stable 点；texel0/1 全过），双端 roughness 读回混合值一致（0.792）。两个矛盾事实：① base-uv1 同几何/同方向光/常量金属已过门，排除直射数学差；② roughness 一致若为真则输入一致、颜色不应差 4.9%。**归因失效点已定位**：两端 roughness 读回通道语义不同（native=normal 附件 alpha=材质 rough；web=HDR 附件 alpha），"输入一致"结论不可靠。下一刀先修 Web 侧 roughness 读回通道（从 normal/材质输出读），再重跑 mr-linear 对拍——预期暴露真实的 metal/rough 采样差或证实输入一致后重归光照端。
