# Deep(WebGPU)对象级/选择描边(2026-10-03)

目标:让 Deep 原生支持实例描边(模型 `effects.outline` 与选中高亮同源),与作者 three `OutlinePass` 视觉对齐,
并移除 `useAppRuntimeEffects` 对"含描边场景强制保留 WebGL"的回落,Deep 仅在能力缺失时才回落(fail-closed)。

## 1. 现状核查(动手前)

### 已有(不重建)
| 项 | 位置 |
|---|---|
| render packet 实例 `outline?: boolean`,编码为表面 flags **bit 256**(与 Native `surface_flags` 对拍) | `packages/deep-engine/src/renderPacketTypes.ts`、`renderPacketBatches.ts:66`(`+= 256`)、`runtimePackage/renderPacket.ts`(字段白名单) |
| 三条 packet 编译链已把 `effects.outline` 写成实例位 | `delivery/compileSceneRenderPacket.ts:152`、`compileLinearPrefabRenderPacket.ts:56`、`sceneSnapshotRenderPacket.ts:40`(各有单测) |
| 作者路径(three)描边:`OutlinePass`,可见 `#4d9fff` / 被遮挡 `#234a71`,`edgeStrength = postProcessing.outlineStrength`(默认 2.5),thickness 1,glow 0 | `apps/web/src/viewer/postProcessingRuntime.ts:48-82`;WebGPU(three TSL)`webGpuPostProcessingRuntime.ts` 同参 |
| Deep 后处理链:`PbrPostProcessChain`(`encodeOpaque`/`encodeFinal`),AuthorBloom 的"按需 `??=` 懒构造 + 瞬态纹理池 `PbrTransientTexturePool`"模式 | `webgpu/pbrPostProcessChain.ts`、`postprocess/authorBloom*.ts` |
| 每帧后处理覆盖通道 `RenderView.postProcess`(`PbrPostProcessOverrides`) | `webgpu/pbrPostProcessOverrides.ts`;Studio 侧 `studioDeepColorEffects.readStudioDeepPostProcess` |
| 阴影管线同款顶点布局(slot0 位置 / slot1 实例行,`material.w` 即 flags)与 `mesh.draw/drawIndirect` | `webgpu/pipelines.ts` `shadowBuffers`、`packetDraw.ts`、`meshBuffers.ts` |
| 发布链回落策略(`preserve-authored-effects`) | `packages/contracts/src/publicationRendererPolicy.ts` |

### 真实缺口
1. **崩溃根因**:`materialEffectLedger.ts` 在 packet 上传时把"作者值"与"实际打包的 GPU 记录"逐位对账。
   `consumedValues` 读 `surfaceFlags = data[31] % 1024`(含 bit 256),`authorValues` 却从不加 outline 位 →
   任何 `outline: true` 实例都触发 `Material effect ledger mismatch for <id>: surfaceFlags`;
   `PacketBuffers.updateInstances` 的 catch 分支随即 `this.dispose()`(**整个 packet 资源被销毁**),
   `set/setValidated` 同样抛错。所以上层只能在应用层强制回落 WebGL。
2. Deep 没有任何描边渲染:实例位只被打包,**shader/后处理从未读取 bit 256**。
3. 没有掩码(剪影/可见性)目标,也没有描边合成 pass。
4. three 投影桥(`ThreeProjectionBridge`)只投影 `castShadow/receiveShadow`,作者对象的描边意图到不了 RenderInstance。
5. 应用层强制回落写死(`useAppRuntimeEffects`、发布策略 `objectOutlineEnabled`)。

## 2. 设计

**零开销优先**:不新增特性开关位、不改主 opaque pass / 主 PBR 管线集(别人在途改 `pipelines.ts`/`pbrPipelineSet.ts`),
而是**独立的懒构造 pass**:

```
packet 有 outline 实例?  ── 否 ──> 链路逐字节不变(不构造 pass、不编译、不分配、不执行;每帧仅 O(批次数) 次 WeakMap 命中)
        │是
        ▼
  directClear 快路径关闭(需要 HDR 链)
        │
  主 opaque/OIT/TAA 之后、bloom 之前(同作者 EffectComposer:Outline → Bloom → Output):
   ① 掩码 render pass(rg8unorm,全分辨率,深度只读复用主 depth32float)
        draw A "silhouette": depthCompare=always, writeMask=RG, 输出(0,0)   → 剪影内 R=0,G=0
        draw B "visible"   : depthCompare=less-equal(depthBias -4/slope -2), writeMask=G, 输出 G=1 → 可见部分 G=1
        顶点着色器按实例 flags bit 256 剔除未描边实例(推出裁剪体外),几何复用阴影同款 slot 布局
   ② 半分辨率边缘检测 compute(rgba8unorm,mask 2x2 降采样 → ±thickness 四邻差分的模)
        输出 (可见边能量, 被遮挡边能量)(预乘,保证双线性上采样的颜色权重正确)
   ③ 全分辨率合成 compute(rgba16float 瞬态纹理,**不写回 TAA 历史**):
        color += strength * maskOutside * (visibleEdge*visibleColor + hiddenEdge*hiddenColor)   // 线性 HDR,加法
        glow>0 才执行 4 次宽采样(默认 0 → 无辉光采样)
```

与 three 的对齐点:掩码约定(R=0 剪影内/G=可见性)、半分辨率边缘核、仅外侧叠加、加法混合、色阶前叠加、
颜色按 sRGB→线性转换(`#4d9fff`/`#234a71`)、`edgeStrength` 取作者 `outlineStrength`。
**差异(如实)**:three `OutlinePass` 的颜色是固定常量,**并不使用 `effects.color/intensity`**(那两项驱动 glow 材质覆盖,
不是描边),因此 Deep 同样不使用;`PbrInstanceOutlineOptions` 暴露 `visibleColor/hiddenColor/thickness/glow/strength`
供后续扩展,但 Studio 目前只下发 `strength`。

两条数据入口:
- **独立 packet 路径**(发布/静态场景):`compile*RenderPacket` 早已写入实例位 → 修好账本后 Deep 直接可渲染。
- **活投影路径**(动画/形变场景、`ThreeProjectionBridge`):作者对象 `userData.deepOutline === true`(对象自身或任一祖先)
  → 其全部网格后代投影为 `outline: true` 实例。Studio 在 `updatePostProcessingSelection` 把"模型描边对象 + 选中对象(启用选中描边时)"
  同步为该标记(`viewer/deepOutlineTags.ts`),集合变化即 `requestRender()`。

fail-closed:
- 账本继续逐位对账 outline(伪造/丢失 bit 256 仍抛错),只是作者侧也计入 bit 256。
- `deepSupportsObjectOutline()`(`DEEP_INSTANCE_OUTLINE_CAPABILITY`)缺失/为 false 时,应用才保留 WebGL。
- 运行期 Deep 失败沿用既有 `onRuntimeFailure → WebGL`。
- 变形(pose)与 meshlet 簇批次暂不进入掩码:`FrameMetrics.outline.skippedBatches` 如实上报,不静默丢失。

## 3. 实施清单(改动文件)

deep-engine:
- `src/webgpu/materialEffectLedger.ts`(+test):账本对 bit 256 对账 → **修复崩溃**(先写失败测试再修)。
- `src/postprocess/instanceOutlineCpu.ts` / `instanceOutlineWgsl.ts` / `instanceOutline.ts`(+2 个测试文件):选项/线性色/CPU 参考核/WGSL/pass。
- `src/webgpu/packetOutline.ts`、`packetBuffers.ts`(`hasOutline()`/`drawOutline()`)。
- `src/webgpu/pbrPostProcessChain.ts`(懒构造 + 插入 TAA 与 bloom 之间)、`pbrRenderer.ts`(`outlined` 门控、关闭 directClear、传 `stableViewProjection`)、
  `pbrPostProcessOverrides.ts`(`instanceOutline` 外观覆盖)、`pbrRendererTypes.ts`(`FrameMetrics.outline`)、`webgpu/index.ts`、`postprocess/index.ts`。
- `src/threeBridge/objects.ts`、`ThreeProjectionBridge.ts`(+`ThreeProjectionBridge.outline.test.ts`):userData 标记 → 实例位。
- `lab/instanceOutlineProbe.ts`、`scripts/instanceOutlineProbeServer.mjs`:Deep ↔ three OutlinePass 同布局 GPU 对拍探针。

contracts:`publicationRendererPolicy.ts`(+test):对象级描边不再单独要求 WebGL(场景级后处理 `post.outline` 仍随其它屏幕后效保守回落);已重建 `dist`。

web:`hooks/useAppRuntimeEffects.ts`(回落条件改为能力缺失)、`hooks/useAppState.ts`、`viewer/deepOutlineSupport.ts`、`viewer/deepOutlineTags.ts`、
`viewer/viewerEngineRendering.ts`(`outlinedObjects()` + 标记)、`viewer/studioDeepColorEffects.ts`(下发 `outlineStrength`)、
测试:`useAppRuntimeEffects.rendererSwitch.test.ts`、`rendererCapabilities.test.ts`、`viewer/deepOutlineWiring.test.ts`。
`controllers/defaultSceneSample.ts` 未改动(outline 仍为 false)。

## 4. WGSL / 包体积增量
- 新增 WGSL:`INSTANCE_OUTLINE_WGSL` **3.5 KB**(1 个模块:5 个入口 maskVertex/silhouetteFragment/visibleFragment/edgeMain/composeMain),单测限 < 5 KB。
- 新增 JS(pass + 选项 + packet 绘制 + 桥标记,含内嵌 WGSL,`esbuild --minify`):**11.7 KB / gzip 4.3 KB**。
- 无新增依赖。主 PBR WGSL、主管线集、frame-graph 零改动。
- 运行期:无描边实例 → 0 次 shader 编译、0 纹理/缓冲分配、0 次 GPU pass。有描边时:3 个瞬态纹理
  (mask `rg8unorm` 全分辨率 2 B/px、edge `rgba8unorm` 半分辨率 1 B/px(等效)、输出 `rgba16float` 8 B/px,经瞬态池复用),
  2 个小 uniform(64 B + 48 B),+1 render pass(2 次实例 draw)+2 compute pass。首次出现描边时同步创建 2 条 render + 2 条 compute 管线(一次性微卡顿,未做异步预热)。

## 5. 实施结果

### 测试
- deep-engine:`tsc --noEmit` 无新增错误;`vitest` 新增 + 改动用例全绿(账本 +1、描边 CPU/WGSL/override 7、pass(mock device)3、packet 描边 +1、桥标记 2);
  `src/webgpu src/postprocess src/threeBridge src/renderPacket src/runtimePackage` 337 文件 2912 例全绿。
  全仓 `vitest` 另有 4 文件 10 例失败,均不在本任务范围(`lab/c8F32Inputs`:生产着色器源指纹被他人在途的高级材质改动漂移;
  `j3DFullLayerMatrix`、`iesSamplingWgslChecksum`、`materialMetalReflectionSampling` 5 s 超时)。
- contracts:`tsc -p .` 通过并重建 dist;`publicationRendererPolicy.test.ts` 3/3。
- web:`tsc --noEmit -p .` 0 错误;相关 vitest(rendererCapabilities / studioDeepColorEffects / rendererSwitch / compileSceneRenderPacket /
  scenePublicationCompatibility / webGpuPostProcessingPlan / deepOutlineWiring)全绿。

### GPU 实测(Chrome WebGPU,RTX 4060,1920×1080,深色背景)
同一布局(球/墙/圆柱/方块,其中球、圆柱、方块描边,方块被墙遮挡)分别走 Deep(`PbrRenderer` + `outline:true` 实例)与 three `OutlinePass`:
证据 `docs/reports/deep-outline-20261003/`:
- `deep-outline-on|off-1920x1080.png`、`three-outlinepass-1920x1080.png`、`compare-wall-cylinder-deep-vs-three.png`。
- Deep:`metrics.outline = { drawCalls: 6, skippedBatches: 0 }`,`postProcessPasses 37 → 40`,设备诊断为空(无校验错误/账本异常)。
- 结论:描边位置、厚度(≈2–3 px)、可见色 `#4d9fff` 与被遮挡色 `#234a71`(**被墙遮挡的方块六边形轮廓正确透出**)与 three 一致;
  Deep 的边缘经半分辨率双线性上采样更平滑(three 为阶梯状)。两侧场景光照/地面不同(Deep 为 IBL + 阴影),故绝对亮度不可逐像素比,
  峰值叠加量 Deep 约为 three 的一半(明亮地面 + 色阶压缩所致,`strength=6` 探针参数可调高),**未做逐像素 PSNR 对拍**。
- 应用内(Studio,Deep 后端)切换"轮廓":首轮 e2e 中 Deep 保持启用、**不再回落 WebGL**、无 pageerror。

## 6. 遗留 / 风险
1. **独立 packet 路径是不可变快照**:`DeepWebGpuBackend.sync` 在独立包下直接返回已提交包,Studio 内实时勾选"轮廓"在重建/重载 packet 前
   不会在 Deep 视口出现(与该路径下其它实时编辑同一限制;实测首轮 e2e 勾选后 Deep 画面无变化,WebGL 下可见)。
   用户感知上较此前"自动回落 WebGL 立即可见"退步,建议后续让独立包路径在 `outlinedObjects` 变化时走 `updateInstances`(现成 `outline` 位)或重编译。
   活投影路径(动画/形变场景)经 userData 标记即时生效,未能在应用内 e2e 单独验证(无可用动画场景)。
2. 应用内 Deep 终验受阻:第二轮起 Deep 创建失败于**他人在途**的 `sceneSnapshotRenderPacket`(`基础体 sample-pedestal 的材质需要适配:clearcoat`),与描边无关;
   描边的 Deep 实渲染由探针(同一 `PbrRenderer`/同一 packet 位)覆盖。
3. 选中高亮(`postProcessing.outline` + inspectedObject)在活投影路径已接标记;独立包路径无选中重绘通道(同 1)。
4. 变形(pose)与 meshlet/簇批次不进入掩码(`skippedBatches` 上报);无 GPU 剔除的全批次顶点着色(仅在存在描边时发生,开销同一次阴影 draw 量级)。
5. 未接入 frame-graph(pass 为私有、不计入 `describePasses`/capture 计划,以避开他人在途的 frame-graph 改动);J4 能力清单未登记 `instance-outline`。
6. 发布策略:对象级描边不再强制 WebGL 发布(`preferredPublicationRenderer` 现返回 webgpu);云渲染 Worker 的描边实机回归未做。
7. 颜色/厚度/辉光仅 Studio 下发 `strength`;`effects.color/intensity` 与 three 一致不参与描边。
8. 首次出现描边时同步创建管线,可能有一次性卡顿(未做异步预热)。
