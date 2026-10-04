# B2 Brief-VSM M2 验收记录(2026-10-04)

> 任务书:`docs/specs/ue-class-b2-task-briefs-20261004.md`(六专项);B1 实施基线:
> `docs/specs/ue-class-b1-vsm-implementation-20261003.md`。证据目录 `test-output/vsm-20261003/`。

## 现状核查结论(不重建声明)

B1 已交付 VSM M1 完整切片(合同 `DisplayShadowMode`、三环 clipmap 规划器、页表驻留 Top-K、
页物化管线、采样 WGSL、组 0 绑定 12/13/14、级联保活回退)。M2 任务 = 在 M1 上验收并修复
缺陷,不是重建。真实缺口:B1 验收⑤(阴影带误差)FAIL 且 ① 的 99.2% 为"无影可测"假阳性
(虚拟腿实际全影/无影,边缘度量为空集伪零)。

## M2 定位与修复(两项根因,均真机定位)

### 根因一(主因):组 0 虚拟绑定从未挂上 —— 主 pass 采样的是占位资源

`PbrMainBindings` 构造函数收下 `environment` 即丢弃(`environmentRef` 恒 undefined),
而 `setVirtualFrameBinding` 以 `if (this.environmentRef)` 门控组 0 重建 → 静态环境下
绑定永远停留在构造期的占位(16B 零页表 + 4×4 零 atlas)→ 渲染端每像素解析到
slot=0/深度=0 → **全域 visibility≈0 全影**。B1 的"细杆全亮"实为全影误读(0.585 = 环境光
地板,与级联腿全影 0.609 吻合;B1 的"GPU 页表与 CPU 驻留 216/216 一致"校验的是资源
内容而非绑定,验错了对象)。
**修复**:`packages/deep-engine/src/webgpu/pbrMainBindings.ts` 构造期落地
`this.environmentRef = environment`(1 行 + 注释)。
定位手段:slot/深度/uv 三级可视化探针(占位 atlas 填 0.5 后地面明暗以 ndc.z=0.5 精确翻转,
实锤绑定占位)。

### 根因二(次因):粗向单链 mip 回退 → 细杆阴影丢失

细页按遮挡体屏幕误差物化(CPU desiredMip 主体是遮挡体),着色端期望 mip 按接收像素
fwidth 足迹计算 —— 接收点比遮挡体远时期望更粗(desired 直方图 3..7,主峰 4-5),
粗向链直达被钉住的顶 mip(10.9cm/texel,细杆不可见)且永不回试细页。
**修复**:`packages/deep-engine/src/webgpu/virtualShadowSampling.ts`
`deepVsmResolveRing` 改为**就近驻留 mip 双向搜索(同距先粗后细)**,命中细页时
`texelWorld = max(页 texel, 请求足迹)`(滤波宽度按足迹自宽,细页不欠采样)。
CPU 镜像单测锁定走查序(`virtualShadowSampling.test.ts`)。

## 修复后验收(真机 headless Chrome WebGPU,1080p,16 384 实例合同场景)

| 门 | 结果 | 数据 |
|---|---|---|
| ② VSM 全管线帧时 ≤2.5ms | **PASS** | virtual gpu-frame p50 = **1.592ms**(绝对值≤2.5;Δp50 = +0.123ms vs 级联 1.469ms;p95 1.779ms) |
| ③ 动态设备阴影延迟 ≤2 帧 | **PASS** | 平移 0 帧 / 旋转 0 帧 |
| ④ 零洞 | **PASS** | nonFinite=0、黑斑=0(298 890 样本) |
| ⑤ 阴影带误差 vs 8192 参考 ≤0.4×级联 | **未过(如实)** | meanAbs:级联 0.0039 / 虚拟 **0.022**(B1 0.275 → **12.5× 改善**,比值 70.8 → 5.68);虚拟边界 539px/角密度 0.1948 与参考(539px/0.1948)完全一致 —— 阴影已"对",余差在半影宽度与位置亚像素差 |
| ① 锯齿能量 ↓≥60%(virtual/cascaded ≤0.40) | **未过(如实,见下)** | 近景机位:级联 0.200 / 虚拟 0.1948 / 参考 0.1948 —— 三者重合,该机位锯齿是屏幕像素网格固有的(级联≈8192 参考,meanAbs 0.0039),基线无可降空间 |

### 门①口径说明(诚实条款)

- B1 的 ①"PASS(↓99.2%)"为**假阳性**(虚拟腿无影,边界空集)。
- 近景机位下级联 medium 档实际已达 8192 参考水平(split0 texel≈像素足迹),门①
  在该机位**度量地板**,任何阴影图都无法在此展现分辨率优势。
- 已加远景机位 `VIEW_FAR`(同场景同光照、双腿同相机,**非调场景放水**——基线覆盖
  扩大后 split0 texel 超过像素足迹,基线进入"图受限阶梯",才能度量"分辨率优势
  带来的锯齿能量下降"这一门①本意)。
- 远景机位实测(第三次运行,并行域瞬态后):级联 0.0050 / 虚拟 0.0049(ratio 0.98)——
  **两端同为度量地板**:近景两者同为 1px 屏幕阶梯(0.2),远景两者同为 PCF 滤波软化
  (0.005)。根因发现:**现行级联基线是自适应品质档**(CascadedShadowQualityTier 随
  相机 extent 调整覆盖),任何机位都保持"texel≈像素",不存在 VSM 可降低的
  "图受限阶梯"锯齿 —— 门①的 corner-ratio 口径与"现有级联基线"在本引擎上不构成
  可区分对。如实结论:**门①按现口径不可达(非实现缺陷)**;VSM 的可证优势在
  ⑤(对真源 12.5× 逼近)与细杆阴影存在性(B1 丢失)。若产品仍需 ① 数值,需把
  基线固定为非自适应档(exactProfile medium)或改用对分辨率敏感的度量
  (如 grazing 光细杆阴影的梯度带能量)—— 属验收口径变更,须用户裁决。

## 测试与构建证据

- deep-engine shadows 全套 + virtualSampling + shadowSwitch + checksum:
  **132 passed / 2 skipped**(含新增走查序 CPU 镜像测试)。
- 全量 vitest(808 文件):6319 passed / 10 failed / 53 skipped。**10 个失败全部位于
  并行域在途重构面**(cascadedShadowResources/pbrShadowState/pbrPipelineSet ——
  `binding` 变 getter-only 的半完成重构,错误 `Cannot set property binding of
  CascadedShadowResources` 可复现归因;lab/c8F32Inputs 7 项为 B1 时代已知
  machine-load 抖动),与本任务域文件无关;本任务域文件在隔离运行中全绿。
- `tsc --noEmit`:main **0 错**;lab:本任务域文件(`virtualShadowGpuProbe.ts`)
  **0 错**,余 24 错全部在 `lab/tsrGhostBaselineProbe.ts`(TSR 并行域既有,未触碰)。
- dist:**已重建成功**(GI 线程落定后;含对 `sdfGiSceneAdapter.ts` 的最小类型补丁
  `as const`,语义不变,已披露)。dist 内含双修复产物
  (virtualShadowSampling.js 就近搜索、pbrMainBindings.js environmentRef)。

## 同族排查(阴影四套共享机制)

- **脏标/无效化**:`shadowDirty` 单源(`updateInstances`/`sceneChanged`),级联(374)、
  虚拟(386)、局部光(429)、接触阴影(574)四方消费 ✓ 本次修复未改该机制。
- **预算**:VSM 双预算(maxPagesPerFrame=8 剔除槽上限 + frameBudgetMs)自包含;
  F7 shadowPages 与 sharedShadowAtlas 为局部光域独立预算,不与 VSM 竞争 ✓。
- **retier**:CascadedShadowQualityTier(adaptiveQuality 消费)、contactShadow 三档、
  localSpotShadowAtlasQuality 均为各自域档位;VSM 无档位(页级驻留替代)✓ 无耦合。
- **已知跨域风险(转交)**:rayTracing 线程在 `pbrShader.ts` group 2 新增
  `@binding(3) deepRayTracedShadowMask` —— `VirtualShadowResources.binding` 由
  `pipelines.cascadedShadowLayout` 构造且只提供 0/1/2,若该 layout 收紧为必需
  binding 3,虚拟档构造将 throw(fail-closed 回级联)。需 rayTracing 域接住
  (虚拟 binding 补第 4 资源或 layout 分档)。
- **接收端驻留需求**(M3 方向):驻留请求目前纯遮挡体驱动;本修复后接收像素可消费
  比自身足迹更细的驻留页(足迹自宽),接收端反馈驻留(F3 口径)留待后续。

## 未达标项与下一步

1. 门①:近景度量地板(如上);远景口径待并行域 WGSL 稳定后一次重跑即出数
   (脚本已就位:`scripts/virtual-shadow-gpu.mjs` 远景腿+门①已接)。
2. 门⑤:0.022 vs 级联 0.0039,比值 5.68 > 0.4。下一步假设:PCSS pcssLightWorld=0
   退化为 1-texel PCF,半影宽度与参考(真实光源尺寸)不一致;给虚拟档配置
   pcssLightWorld 后应收敛(资源选项已留,`VirtualShadowResourceOptions.pcssLightWorld`)。
3. dist:已重建(见上);GI 线程如继续演进 `sdfGiSceneAdapter.ts`,以其自身构建为准。
