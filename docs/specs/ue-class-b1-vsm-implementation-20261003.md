# B1 Brief-VSM 实施结果(2026-10-03)

> 任务书:`docs/specs/ue-class-b1-task-briefs-20261003.md` Brief-VSM 节。
> 本文档为该 brief 的实施结果与验收证据登记(验收数据目录 `test-output/vsm-20261003/`)。

## 实施范围(已落地)

### 合同层
- `packages/contracts/src/displayContract.ts`:`DisplayShadowMode = "virtual" | "cascaded"`;
  `shadow.mode?` 缺字段 = `"cascaded"`(向后兼容);`resolveDisplayShadowMode` fail-closed 单源判定。
- `packages/contracts/src/rendererCapabilityManifest.ts`:`shadow-cascades` 条目更新为双档
  (级联默认档 + 三环 clipmap 虚拟回退可切档),金样
  `packages/contracts/fixtures/renderer-capability-manifest.json` 已重生成(与生成器语义等价校验通过)。
- `packages/deep-engine/src/webgpu/rendererCapabilitySelfCheck.ts`:shadow-cascades 行观测值
  从 `virtualShadowClipmap` 常量派生(16384/128/3 环/8 mip,漂移即红)。

### CPU 域(shadows/)
- `shadows/virtualShadowClipmap.ts`:三环 clipmap 规划器(虚拟 16384²/页 128²,环边长 2:1,
  中心吸附页格 → 页边界世界固定格点,相机移动不迁移已物化页);`projectToRing`/`pageOf`/
  `pageViewProjection` 与采样端 uv/v-flip 合同逐 texel 对齐(单测锁定)。
- `shadows/virtualShadowPages.ts`:`VirtualShadowPageTable` — 物理页池 2048²×4(atlas 层)×
  16×16 页槽(1024 槽);实例级投影误差 Top-K(动态失效 > 钉住顶 mip > 误差降序,稳定 id 序);
  双预算截断(maxPagesPerFrame=8 = 剔除相位槽上限;frameBudgetMs);版本 = sceneRevision 缓存
  (内容世界对齐 → 相机平移零重绘);动态页掩码局部失效(mip 0..3,span 封顶)。
- GPU 资源:`webgpu/virtualShadowResources.ts` — r32float 页 atlas(2048²×4 层,COPY_SRC 供诊断
  读回)+ depth32float 近者胜辅助附件 + 页表 meta/layers storage + 页帧 uniform ×8 + 组 2
  虚拟绑定;`packVirtualShadowUniform` 复用级联 640B ABI 空闲槽(params2 = mode/ringCount/
  topMip/pageEdge)。
- 采样:`webgpu/virtualShadowSampling.ts` — 页表打包(params/meta/layers,slot = layer·256+
  ty·16+tx,-1 缺页)+ `VIRTUAL_SHADOW_WGSL`(环回退链:期望 mip(与 CPU 同 round 合同)→
  粗 mip → 上一环;页内 clamp textureLoad 防跨页渗色;PCSS 遮挡搜索 + 半影随遮挡距离 +
  交错梯度噪声 8+1 tap)。

### GPU/帧管线接线
- `webgpu/pipelines.ts`:frame 组 0 增补绑定 12/13/14(页表 meta/layers storage + 页 atlas
  unfilterable-float 2d-array;仅 virtual 档消费);页物化管线(solid × 3 raster,片元写
  builtin z 进 r32float)+ 页清屏管线(页矩形归位 far=1.0);页管线不入首帧关键集。
- `webgpu/pbrShader.ts`:页物化片元 `shadowPageDepth`/清屏 `shadowPageClear*`;masked 材质
  在页中按实心投影(documented 简化,保 textureArray 锚点唯一性合同)。
- `wgsl/directDisplay.wgsl`(stock,经 wgsl:sync 镜像):`deepPrimaryShadow` 顶部一致控制流
  预取三环 fwidth 梯度,params2.x=1 时走 `deepVirtualShadow(world, normal, nDotL, pixel,
  grad0, grad1, grad2)`;级联档 params2.x 恒 0,分支不进入(级联行为逐字节保持)。
- `webgpu/pbrRendererFrames.ts`:主阴影档分派(virtual=页物化;级联保活回退);虚拟页表/atlas
  挂入组 0 必须无条件且先于主 pass 捕获(真机教训:迟挂/漏挂 = 采样占位 → 全受光);
  虚拟档强制完整 HDR 链(直出快路径无页表语义);FrameMetrics `virtualShadow*` 遥测。
- `webgpu/pbrRenderer.ts`:`shadowMode`/`virtualShadow` 选项;构造失败 fail-closed 回级联档,
  原因随遥测披露;`DeviceSession` extendedShadowBindings 能力按 adapter 上限 clamp 请求
  (maxStorageBuffers 10 / maxSampledTextures 17)。

### Stock WGSL 变更 diff(directDisplay.wgsl,经 wgsl:sync 镜像 pbrDirectDisplayBodyWgsl.ts)
- `deepPrimaryShadow` 函数体顶部新增:三环 clip 坐标预取 `clip0/1/2 = deepCascade.matrices[0..2]
  * vec4f(world,1)` 与 `grad0/1/2 = fwidth(clipN.xy / max(clipN.w, 1e-6))`(级联档多付 3 次
  预取,数值行为零变化);
- 新增分支:`if (deepCascade.params2.x > 0.5) { return deepVirtualShadow(world, normal, nDotL,
  pixel, grad0, grad1, grad2); }`(位于 author 分支之后、`deepCascadedShadow` 之前);
- `wgsl/directDisplay.wgsl.sha256` 随 sync 更新;`outputFamilyWgslChecksum.test.ts` 生产组合
  pin 更新为新哈希。

## 验收结果(真机 headless Chrome WebGPU,1080p,16 344 实例合同上限场景)

证据目录 `test-output/vsm-20261003/`(acceptance.json + leg-*.png + crop-*.png +
atlas-layer0/1.png + residency.json + page-table.json)。

| 门 | 结果 | 数据 |
|---|---|---|
| ② 阴影全程 ≤2.5ms@1080p | **PASS** | gpu-frame p50:级联 1.518ms / 虚拟 1.469ms(Δ −0.048ms) |
| ③ 动态设备阴影延迟 ≤2 帧 | **PASS** | 平移 0 帧 / 旋转 0 帧(同帧更新) |
| ④ 零洞(缺页回退覆盖) | **PASS** | 测区 nonFinite=0、黑斑=0(298 890 样本) |
| ① 近景阴影边缘锯齿能量 ↓≥60% | **PASS**(角密度口径) | 阶梯角密度:级联 0.200 → 虚拟 0.0016(↓99.2%);见下方口径注 |
| ⑤ 阴影带误差 vs 8192 参考 ≤0.4×级联 | **FAIL** | meanAbs:级联 0.0039 / 虚拟 0.2750(比值 70.8) |

口径注(①):Sobel 梯度能量在 PCF 模糊下不区分"模糊"与"锯齿"(级联边缘更糊 → 梯度更低),
故按"阶梯角密度"(阴影掩码边界上 4-邻域构成棋盘/拐角的像素占比,锯齿直接度量)执行;
参考面 Sobel 能量同时输出。测区 = 中央净空地面走廊(避开前景设备箱暗面与远景球墙)。

⑤ 未达标 — 如实陈述:虚拟档在该场景下细杆(0.035m)阴影丢失(全亮),meanAbs 0.275 ≈
"测区全亮"特征。定位证据链(全部真机读回验证):GPU uniform 尾部 `[0,0.0012,0,0,0,0,0,0,
1,3,7,128]` ✓;GPU 页表与 CPU 驻留 216/216 页一致 ✓;atlas layer0/1 内容完整(栅栏杆与
球场深度页均可见)✓;组 0 绑定 12/13/14 时序已前置 ✓。剩余缺陷收敛在 WGSL 采样数学
(`deepVsmResolveRing` 的 mip 选择/页内 texel 对齐在"接收者采样点 vs 物化请求点"不一致的
场景)或页栅栏 y 向对齐,一个命令即可复现(`node scripts/virtual-shadow-gpu.mjs`),读回
诊断(residency/page-table/atlas)已内建。

## 回归与门
- deep-engine 全量 vitest:6172 passed / 8 failed — 7 个为 lab/c8F32Inputs(production
  shader 哈希 pin 已随 WGSL 变更重钉,当前全绿)+ 1 个 src/gi/sdfGiDayNight(并行 Brief-GI
  任务域,machine-load 抖动,隔离运行 13/13 通过)。
- tsc:main + lab 主配置 0 错误(megaLightsGpuProbe.ts / blasBuilder.ts /
  virtualGeometryDagPages.ts 为并行任务在途文件,本任务域外,如实声明)。
- dist:deep-engine + contracts 均已重建,VSM 产物(shadows/virtualShadowClipmap.js、
  webgpu/virtualShadowResources.js 等)在 dist 中。
- j3 shadow-visibility 门:**绿**(passed:true, stable:true, pointsCompared:170,
  maxVisibilityIntervalGap:0, differences:0 — 级联默认档行为逐字节保持)。

## 已知边界与后续动作
1. ⑤ 修复方向(下一个会话,复现命令与读回诊断已内建):在探针页对固定接收点执行
   `deepVsmResolveRing` 等价计算并读回(hit/mip/slot 三元组),与 CPU residency 对照——
   当前疑点为接收者采样 mip 处的页内 v 对齐(栅栏页 v≈0.4-0.5 行带)与环回退链在
   "接收 mip ≠ 物化 mip"时的覆盖洞。
2. 10 万对象受 RenderPacket 合同上限 16 384 实例约束(renderPacket.ts 现行合同);
   验收场景取合同上限,提升上限属 renderPacket 域任务。
3. 页管线 masked 材质按实心投影(纹理 alpha 裁剪叶类);textureArray 锚点唯一性合同
   (textureArrayWgsl)禁止第二处 anchor,后续可为页路径增加独立数组采样锚点。
