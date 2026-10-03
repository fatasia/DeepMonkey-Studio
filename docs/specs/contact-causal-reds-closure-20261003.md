# contactShadows 默认开:因果红收口批(2026-10-03)

> 承接 Z2/Z3.5 contactShadows 默认 false→true(`pbrRendererFeatures.ts` DEFAULT,用户授权的质感默认)
> 与前批 4 例因果红(pbrPipelineSet 3 + outputFamily pin)。本批收掉剩余 3 例,全部归因判定后
> 修"错的一侧",未放宽任何断言。

## 现状核查(动手前)

- `git status --short`:仓库存在大量未提交改动(322 files);`packages/deep-engine/src/webgpu/`
  与 `src/shadows/` 内 `pbrFramePlanExecutor.ts`、`pbrFrameReceipt.ts`、`pbrRenderer.ts`、
  `contactShadow.test.ts` 等均带未提交改动(前批 Z2/Z3.5 + C10 链尾对齐),本批在其上增补,
  未回退任何已有改动。
- 例 1 消费方:`describeContactApplyPass` 唯一生产调用点在 `pbrFramePlanExecutor.collectActualPbrFramePasses`;
  `contactShadow.test.ts` 只断言 passOrder/reads,不钉 usages → claims 可安全修正。
- 例 2 考古:`frame_bindings.rs` 已无任何 `include_str!`;`native_mesh_wgsl.rs` 持唯一
  canonical include;Rust 侧守卫 `tests/cascaded_shadow.rs:272` 注释已声明装配链迁移。

---

## 例 1:pbrGodRaysIntegration.test.ts × 2(enabled=false/true)

**现象**:`contact-apply.resources.volumetric-fog-hdr.usages:
planned=["copy-src","storage-binding","texture-binding"]
actual=["copy-src","render-attachment","storage-binding","texture-binding"]`。

**归因判定(以 pbrRenderer.ts 真实编码为唯一权威)→ claims 侧错**:

真实编码证据链(`shadows/contactShadowResources.ts` encode + `webgpu/pbrRenderer.ts:732`):

1. `pbrRenderer.ts:732`:`contactShadows.encode(encoder, contactFrame, this.targets.linearDepth,
   finalEffects.color, ...)`,输出 `applied.texture` 直接作 present 输入。
2. apply 是 **`encoder.beginComputePass`**(contactShadowResources.ts:222),不是 render pass:
   - 输入 HDR(finalEffects.color,即 volumetric-fog-hdr 等链尾纹理)经 bindGroup
     **binding 0 `texture: { sampleType: "float" }` 纹理采样** —— texture-binding;
   - 输出 contact-hdr(applyTexture)经 **binding 3 `storageTexture: { access: "write-only",
     format: "rgba16float" }` storage 写入** —— storage-binding;
   - 链路里**没有任何 `beginRenderPass` / 渲染附件路径**,输入纹理从不作 attachment。
3. 旁证:`volumetricFogComposite.ts:127` 同为 compute storage 写入 volumetric-fog-hdr,
   plan 合同 `["storage-binding","texture-binding","copy-src"]` 正确,一侧都不用动。

结论:任务假设的"纹理读+渲染附件写"不成立,真实形态是 **纹理读 + storage 写**;
`describeContactApplyPass` 对输入资源硬编码 `render-attachment` 是错的 → **修 claims**。

**同族清剿**(同一机制缺陷"contact 资源被按'渲染到新纹理'声明",claims 与 plan 合同互相
镜像同一个错,故对拍不炸但双双背离真实编码):

| 文件 | 修复 |
|---|---|
| `shadows/contactShadowResources.ts` | `describeContactApplyPass`:输入 claim usages 改为按资源合同逐 id 声明(新增 `CONTACT_APPLY_INPUT_USAGES` 表,未知 id 显式抛错);contact-hdr claim 去掉 `render-attachment` → `["storage-binding","texture-binding","copy-src"]` |
| `webgpu/pbrFramePlanResources.ts` | `contact-hdr` 资源合同 usages 同步去掉 `render-attachment`(真实生产者是 compute storage 写) |
| `webgpu/pbrOutputBindings.ts` | `describePbrPresentPasses`:contact-hdr 从 render-attachment 分支移入 storage 三元组分支(present 只采样它) |
| `webgpu/pbrPostProcessChain.ts` | `temporal-upscale` 输入 claim:contact-hdr 与 ao-hdr 分离,归入 storage 三元组 |

aligns 惯例:`pbrOutputBindings.describePbrPresentPasses` 与 `pbrPostProcessChain` 的
`*InputUsages` 逐 id 映射同款书写;逐资源 id 精确声明、未知 id fail-loud。

**证据**:修复后 `pbrGodRaysIntegration.test.ts` **6/6 绿**(enabled=false 与 true 两例均过
`assertPlanMatchesActual`,mismatches=[],且 `volumetric-fog-march.reads` 的
shadow-atlas 条件断言不动、executor 映射不动 —— 未放宽)。

## 例 2:cascadedShadowMathWgslChecksum.test.ts × 1

**现象**:断言 `frame_bindings.rs` 含 2 处
`include_str!("../../deep-engine/wgsl/cascadedShadowMath.wgsl")`,实际 0 处。

**考古(现状即权威)**:

- 历史:commit `1237eb00` 引入断言时 frame_bindings.rs 两工厂(ordinary+RT)各自 include_str,
  共 2 处。
- 迁移:commit `3c681dc1`(J2-B1 单源重构)把 CSM WGSL wiring 移入 `native_mesh_wgsl.rs`;
  `frame_bindings.rs:29/39` 改为只经 `native_mesh_wgsl::native_mesh_shader_source()`(ordinary)
  与 `native_mesh_wgsl::native_mesh_rt_shader_source()`(RT)消费装配链。Rust 侧守卫
  `tests/cascaded_shadow.rs:272-275` 已按新形态断言,TS checksum 测试漏更。
- 现状 wiring:`native_mesh_wgsl.rs:9` 持**唯一** canonical include(在 ordinary 工厂);
  RT 工厂 = `enable wgpu_ray_query;` + **ordinary 源整体拼接** + RT fragment —— canonical
  文件经组装链同样到达 RT 工厂,历史意图"ordinary 与 RT 同一 canonical 单源"真实存续。

**修复**(`src/shadows/cascadedShadowMathWgslChecksum.test.ts`,按现状修断言并保留等价意图):

1. `native_mesh_wgsl.rs` 中 canonical include 恰好 **1 处**(防拷贝漂移);
2. `frame_bindings.rs` 同时引用 ordinary 与 RT 两工厂函数名(两路生产接线仍在);
3. RT 工厂函数体内必须调用 `native_mesh_shader_source()`(RT 经 ordinary 源消费同一
   canonical 文件,不许私接第二份);
4. `frame_bindings.rs` 不得再出现对该 wgsl 的直接 `include_str!`(守卫单源性质);
5. 原有"canonical 源无绑定声明"断言保留不动。

**证据**:修复后该文件 **4/4 绿**。

## 回归证据

| 范围 | 结果 |
|---|---|
| 三例目标测试 | pbrGodRaysIntegration 6/6 + cascadedShadowMathWgslChecksum 4/4 全绿 |
| 基线三文件(pbrFramePlanExecutor + pbrFrameGraph + contactShadow) | **38/38 绿**(历史基线 27 未破;工作区未提交批次新增用例一并绿) |
| `src/shadows` + 指定 webgpu 回归 | 18 文件 151 过 / 2 skipped / 0 红 |
| `src/webgpu` 全域 | **225 文件 1829 过 / 26 skipped / 0 红** |
| 类型检查 | `tsc --noEmit` exit 0 |

## 诚实声明

1. **并发线瞬态红(非本批、未处理)**:第一轮 shadows 域回归时
   `localSpotShadowShader.test.ts` 曾红(`resolveLocalShadowSoftness(undefined)` 期望 0 实得
   0.35)——系并行会话对 `localShadowSoftness.ts` 的 Z2/Z3.5 默认软阴影档改动在两次读取之间
   又被该线回退到 HEAD,属并行线瞬态;复查时文件已回到 `return 0`,该测试随之转绿。本批
   未触碰该文件。若该线再次落地 0.35 默认,需同步更新该测试第 10 行断言。
2. **GPU 真机未跑**:GPU 被 F5 线占用,本批全部证据来自纯 TS 单测 + tsc,无真机帧验证。
   例 1 修复改变的是计划/声明层(claims 与合同),不触任何运行时编码路径;真实编码行为
   (compute storage 写)本就如此,无行为变化风险。
3. **未清项(记录不改)**:`contactShadowResources.encode` 创建 applyTexture 时
   `GPUTextureUsage` 仍含 `RENDER_ATTACHMENT`,但全链路无渲染附件用途(超集分配,浪费少量
   资源位,非正确性缺陷);本批守住"不碰运行时"边界未动它,留给后续质感批次顺手清理。
4. 未 commit / 未 push;未测量帧时;未触碰禁改清单
   (`apps/web/src/ai/`、`apps/api/`、AiAssistantPanel*、ViewerSceneCommandPort*、
   editorSceneWriteDriver*、rendererCapabilityUserFace*、jc-i-continuation-20261001.md)。

## 本批改动文件清单

- `packages/deep-engine/src/shadows/contactShadowResources.ts`(claims 修正 + 输入 usages 表)
- `packages/deep-engine/src/webgpu/pbrFramePlanResources.ts`(contact-hdr 合同)
- `packages/deep-engine/src/webgpu/pbrOutputBindings.ts`(present claim)
- `packages/deep-engine/src/webgpu/pbrPostProcessChain.ts`(upscale 输入 claim)
- `packages/deep-engine/src/shadows/cascadedShadowMathWgslChecksum.test.ts`(断言对齐现状)
