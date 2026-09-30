# I-C18 生产体积光

复用已完成的 C18 ray-march 核，把真实主光遮挡接到 Studio 体积雾消费链。生产与作者两轮已通过，本项完成。

## 现状核查

1. 全 packages/apps 源与 git 未跟踪检索：volumetricGodRays WGSL/CPU/合同已存在，仅测试消费，无生产 pass/dispatch。VolumetricFogPass→PbrPostProcessChain 已实际运行。
2. 已读 VolumetricGodRaysOptions、VolumetricFogSource/Profile、ScenePostProcessingState、CSM资源/固定624B uniform：介质、步数/强度硬顶已有；作者状态尚无 god rays 开关/强度。主光CSM深度数组已由实际场景几何绘制。
3. 现有资源准入、 transient pool、WGSL mirror/sidecar、Vitest、Playwright 足够，不加依赖。旧 expansion-plan 路径当前不存在，权威handoff/清单明确本刀后继。
4. 已读实际消费：PbrRenderer主光/CSM prepare→shadow draw→postProcess input→fog march/composite；StudioDeepColorEffects把作者设置传到同一链。现CSM binding仅fragment visibility，compute需要借用相同纹理/uniform建立compatible view binding，不重做阴影平台。
5. 已查C18三个核测试44测与G7 fog GPU runner/CPU/pass/集成证据；既有shadow basis/rasterize CPU不用来每帧CPU造图，生产遮挡必须来自真实GPU CSM。test-output历史副本不当当前接线证据。
6. 已读0930handoff、remaining estimates、active recovery ledger与权威剩余清单：a4c12e10已完成核不重建，本刀为产品dispatch/遮挡/设置/两轮实机。

已有（不重建）：WGSL光散射/Beer-Lambert/HG核、CPU镜像、预算、CSM几何遮挡、半分辨率scatter、HDR composite、体积雾开关/数值编辑及持久化、资源/epoch/帧图。

真实缺口：生产god-ray compute宿主、沿同一CSM资源查询、作者开关/强度、当前primary light/view坐标接线与实际遮挡/关闭/回收证据。

## 接线决策

复用canonical march kernel，宿主只替换 shadowVisibility 与追加view→world参数，查询已有CSM深度/矩阵；每步1次 nearest textureLoad，保留32–64半分辨率预算，不调用CSM表面9tap PCF。空覆盖依既有CSM语义lit。CSM资源借用、所有权仍在原shadow owner，不创建第二shadow图、不CPU rasterize场景。

God rays 为原volumetricFog后的遮挡版本，使用同scatter/HDR资源与合成，不叠两套雾。关闭时保留已有雾输出；新增独立开关可选并沿原作者保存。host pipeline/208B参数按需创建，记录created-device epoch，关闭不调度；设备替换重建owner，旧对象拒绝encode。

设计读题：Unity体积介质光束与Studio深色环境工具；仅使用base.css令牌。实际验收两轮深色1920×1080，遮挡/无遮挡/开关/强度/取消资源与GPU验证；相同基础fog与strength=1无遮挡按已有CPU参考核对，记录预算和实机观察值。

## 文件锁

独立 `fog/volumetricGodRaysPassWgsl.ts`、`fog/volumetricGodRaysPass.ts/.test.ts`、`fog/volumetricGodRaysPassTypes.ts`；root释放窗口后接PbrPostProcessChain/PbrRenderer/CSM source getter/帧图叶子及contracts/作者设置。实机根因追加pbrPipelineSet的fog-only附件选择、fog composite/outputBindings COPY_SRC声明和viewerEngineRig两字段snapshot入口；不碰C8 shader或J3 Bridge。

## 独立叶子检查

5聚焦叶子测试通过。kernel compute入口以下body与canonical生成镜像逐字一致；宿主追加64B逆view矩阵，总208B。原CSM矩阵/splits复用同一624B合同，单nearest深度tap，不新建shadow图。借用CSM资源不释放，standalone只拥有参数/scatter两资源；相同尺寸与源复用binding，resize上传失败销毁候选保留旧target。ready设备替换、lost、重复dispose与旧owner调用均已覆盖。

## 生产检查

主线程engine 9文件87测通过；作者3文件15测、contracts 2测通过，共104聚焦测；engine/Web/lab/contracts类型通过。God-ray pass按作者profile懒创建，原fog-only返回旧march，零强度保留消光；主光颜色×强度与同帧view变换复用，原CSM纹理/uniform/sampler只借用。帧图精确声明shadow-atlas读取与实际executor，复用旧march/composite两pass身份。原fog HDR补COPY_SRC让既有present-color诊断可读，不分配第二输出。

实机发现并修两处已有/新增消费缝：pbrPipelineSet忽略volumetricFog导致雾单独开启时单附件PSO用于4附件MRT；viewerEngineRig白名单遗漏新体积光字段导致UI值变化但真实PUT快照丢值。各自已加CPU回归，实际失败记录保留。root最终engine/Web构建及snapshot两字段修复后的Web构建均已通过，编辑器两轮已通过。

数值证据不可变副本 `test-output/i-series-0930/god-rays-numeric-20260930/evidence.json`：两fresh realm、各新renderer/device，dark1920×1080，sourceFresh/stable/pass=true。shader `f646d0375ce79af912544cd2a789a567949f24ea3beff5fc189957ca01f08811`，bundle `4325c3d655afe805c9e17b36a3affe3e963ac8466f1b2f26dce27514e9cb4b3b`。真实两层512 CSM遮挡由实际geometry绘制；21样点，clear1-clear0消掉表面基色/阴影差异后独立对拍已有无影CPU核，最大误差0.003308925637，shadow2-shadow0与2×(shadow1-shadow0)最大误差0.0015869140625；3点遮挡差>0.01。原雾返回与关闭全部雾后present-color=opaque-hdr逐像素maxError=0。暖资源65→66仅多208B参数；再开关稳定66，dispose后0、validation/diagnostics空、同device epoch0。

视觉记录 `test-output/i-series-0930/god-rays-visual/evidence.json`：相同数值阈值，两fresh realm全通过。仅lab显示曝光由1改为0.18，降低白场、提高遮挡可读性，生产源未改；lab新SHA `76eea2942953a715609e4b83349a8aee5ace1d82816d42fb816cdb9af3801665`、bundle `eec11b00e2cf9ed409b43d55139d0d8dd1e93c5b95dfb04a6d44a8fc1cd96fb6`，原数值fixture与source身份没有被覆盖。已目视r1 shadow-one，原高曝光图只作数值诊断，不计工业成品美术验收。

## 编辑器与视觉闭环

`test-output/runs/2026-09-05/god-rays-editor-5DmfAF/report.json` 两fresh contexts全部通过，实际Studio作者菜单/非空设备primitive/Deep WebGPU请求路径。真实滑块Home=0、ArrowRight→0.7保存载入；End=8继续向右保持8，Home继续向左保持0；关闭体积光、保留体积雾与强度0保存再载入，重新开关显示0。pageerrors为空。作者bundle `AppStudioShell-DbIZQQ9R.js` SHA `957e097a1a79d10bd51b4ec24320e0a5536b1fb5d90b9b915adbece9c273f7ca`。

已目视 `r1-configured.png` 和 `r2-reloaded-zero.png`：沿既有base.css按钮/滑块/数值/面板令牌，新增开关与强度紧邻雾参数，数值0.7/0.0清晰。强度控件x1307、y935.1875、236×16，未越1920边界；环境窗继续既有纵向滚动，完整雾参数可滚动查看。同族检查覆盖雾密度/步数/高度/各向异性、composer关闭/雾关闭/光关闭、snapshot clone与legacy值。

对标：Unity的参与介质积分与遮挡查询、Studio现有工业环境工具的数值/单位密度；本刀诊断plate用于看遮挡与连续介质，不代替全场景美术验收。10维自评：层级9.5、一致性9.6、间距9.5、中文9.5、对比9.5、操作9.7、反馈9.6、布局9.5、体积效果9.0、性能9.7，平均95.1/100。

范围：Deep WebGPU生产主光体积效果与Studio可保存配置。Native/WASM/Three的原雾降级边界保留，本刀没有新增它们的god-ray消费。全仓source-size检查仍有19处既有>800行超限，含scene.ts983→987与pbrRenderer976→984；本刀独立叶子均<180行。该全仓门未通过，未扩域重排无关模块。

## Harvest 文件

31文件，生产源与runner冻结；本地test-output为实测附件，I-C17草稿不在本次清单。

```text
packages/contracts/src/scene.ts
packages/contracts/src/sceneValidation.ts
packages/contracts/src/sceneGodRays.test.ts
packages/deep-engine/src/fog/volumetricGodRaysPass.ts
packages/deep-engine/src/fog/volumetricGodRaysPass.test.ts
packages/deep-engine/src/fog/volumetricGodRaysPassTypes.ts
packages/deep-engine/src/fog/volumetricGodRaysPassWgsl.ts
packages/deep-engine/src/fog/volumetricFogComposite.ts
packages/deep-engine/src/webgpu/pbrGodRaysFrame.ts
packages/deep-engine/src/webgpu/pbrGodRaysIntegration.test.ts
packages/deep-engine/src/webgpu/cascadedShadowResources.ts
packages/deep-engine/src/webgpu/cascadedShadowResources.test.ts
packages/deep-engine/src/webgpu/pbrFrameGraph.ts
packages/deep-engine/src/webgpu/pbrFramePlanExecutor.ts
packages/deep-engine/src/webgpu/pbrFramePlanResources.ts
packages/deep-engine/src/webgpu/pbrOutputBindings.ts
packages/deep-engine/src/webgpu/pbrPipelineSet.ts
packages/deep-engine/src/webgpu/pbrPipelineSet.test.ts
packages/deep-engine/src/webgpu/pbrPostProcessChain.ts
packages/deep-engine/src/webgpu/pbrPostProcessOverrides.ts
packages/deep-engine/src/webgpu/pbrRenderer.ts
packages/deep-engine/lab/iC18GodRaysProduction.ts
scripts/i-c18-production-god-rays.mjs
apps/web/src/components/ScenePostProcessingEditor.tsx
apps/web/src/components/ScenePostProcessingEditor.test.tsx
apps/web/src/viewer/studioDeepColorEffects.ts
apps/web/src/viewer/studioDeepColorEffects.test.ts
apps/web/src/viewer/viewerEngineRig.ts
apps/web/src/viewer/viewerEngineRig.godRays.test.ts
apps/web/scripts/gate-god-rays-editor.mjs
docs/specs/i-c18-production-god-rays-20260930.md
```
