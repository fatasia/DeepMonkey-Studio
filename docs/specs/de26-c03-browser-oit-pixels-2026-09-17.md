# DE26/C03 浏览器生产 OIT 像素切片

已在真实 Chrome WebGPU 硬件适配器上验证生产 weighted OIT 累积、合成与透明语义。没有修改 Native、Deep2D、X_T 或共享总账。

## 范围与复用

新增 `packages/deep-engine/lab/c03TransparencyPixels.ts` 与 `scripts/fixtures/run-c03-browser-pixels.mjs`。使用生产 `DeviceSession`、`WeightedOitPass`、`weightedOitColorTargets` 与原版 `WEIGHTED_OIT_FRAGMENT_WGSL`。夹具仅提供矩形顶点、交叉深度和已知线性颜色，真实 GPU 栅格化、合成到 WebGPU canvas，并从另一 rgba8unorm render target 读回全部 128×128 RGBA 像素。

本片直接调用 production OIT 两个 WGSL 函数，**没有覆盖完整 renderPacket→PBR shader flags 分发、光照/色调映射或编辑器发布链**。front/double 使用真实 WebGPU cullMode；镜像测试反转顶点 X，不能替代生产 packet 的镜像批次/绕序接线验收。不得据此单独关闭 C03 整卡。

## 真实结果

Chrome `153.0.8010.48`，headless，未添加 SwiftShader、软件 WebGPU 或 unsafe flags。适配器报告 `vendor=nvidia`、`architecture=lovelace`、`isFallbackAdapter=false`，设备名称受浏览器隐私限制为空。

两轮：1280×1100 深色、980×1100 浅色。每轮 9 个画布、6 项全帧比较，最大通道差均为 **0/255**：

| 比较 | 结果 |
|---|---|
| straight 与按 alpha 编码的 premultiplied | 相等 |
| 零 alpha straight / premultiplied 与空背景 | 均相等 |
| 两个空间交叉玻璃层，顺序与逆序 | 相等 |
| 镜像 front 与背景 | 相等，背面已剔除 |
| 镜像 double 与 straight front | 相等，双面可见 |

straight 中心像素 `[107,27,17,255]` 与独立单层 alpha 合成参考一致；相对背景最大变化 97，交叉层相对单层最大变化 120，防止“所有画布为空却相等”的假阳性。交叉图左/中/右像素分别 `[99,42,80,255]`、`[75,46,105,255]`、`[52,49,127,255]`，可见深度权重沿空间变化。

两轮 GPU validation=null、DeviceSession diagnostics=[]、console/page errors=0、OIT session-owned resources=0。截图时保留 device/canvas 呈现，页面关闭释放浏览器资源。

`test-output/de26-c03-browser/` 保存完整 evidence、bundled probe、两轮 PNG 和 18 个 `.rgba` 帧；evidence 绑定生产源码、bundle、截图和每帧 SHA-256。原始帧为 128×128、RGBA8、行宽 512 字节。
`evidence.json` SHA-256 为 `7ef9ee331b60c725c7d635625d36a3f46170cf54e5e2a56a51f426bac232e3bc`；
两轮截图 SHA-256 分别为 `aa9d0cac232b37ead334bbd463ab16419d9b367aa34fd39baecfabdfd485fa17`
与 `aa512afdfbb53b3ba46885f8d95f646f8b1ee35660bd617b55301fc404b55e8e`。

## 验证命令

```powershell
node scripts/fixtures/run-c03-browser-pixels.mjs
pnpm --filter @bim-studio/deep-engine exec tsc -p tsconfig.lab.json
pnpm --filter @bim-studio/deep-engine exec vitest run src/webgpu/weightedOitBlendSemantics.test.ts src/webgpu/weightedOit.test.ts src/threeBridge/ThreeProjectionBridge.transparency.test.ts
```

lab 类型检查通过；聚焦测试 25 passed / 1 skipped（既有 skipped，没有修改跳过策略）。浏览器 gate 两轮通过。

## Kimi-95 诊断夹具视觉复检

Design Read：对标 Unity 的透明渲染语义与西门子的可追溯诊断，UI 只用项目 `apps/web/src/styles/base.css` 令牌。红/蓝及清屏数值是数学测试输入，不是新增 UI 配色。为隔离透明语义，不引入雾、Bloom、PBR 环境或动效。

第一轮目检发现 body 全局宽度配合 margin 导致横向溢出、完整 JSON 把页面拉长；修正为 border-box/padding、只展示摘要。随后重新运行两轮并目检，脚本同时断言无横向溢出。同族排查两种 viewport/theme 的所有 9 个画布和标签，均未裁切。

以下评分仅限本诊断夹具的截图/功能范围，不是完整产品画质认证：布局 9、令牌 9、排版 9、状态 9（运行/失败/结果明确；无用户控件）、动效 N/A（静态诊断）、3D 语义可辨识 9、信息设计 9、反馈 9、响应式/主题 9、术语 9（case 名称直接对应 evidence）。未将不适用维度伪造为满分。

本轮待办：完整生产 PBR/材质 flag 分发的浏览器像素对拍、作者端发布链及更广真实透明资产；本切片没有修改产品渲染代码。
