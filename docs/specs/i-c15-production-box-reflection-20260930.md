# I-C15 生产盒投影反射探针

把已有 C15 盒投影核接入 PBR 的 specular IBL 回退，最多两探针；编辑配置沿 Studio 环境持久化。

## 现状核查

1. 全 packages/apps 与未跟踪已检索：现有 reflectionProbeParallax/WGSL/CPU/打包/权重，生产 pbrShader.shade 仍直接采 binding3 单 cube，无盒投影消费。
2. 已读 ReflectionProbeBoxSpec、StudioEnvironment、PbrEnvironmentSource、SceneEnvironmentState、Frame/Mesh ABI：盒/捕获偏移/代际字段已有，场景环境无探针配置，主 frame 0–8、材质1/CSM2/灯3已占用。
3. 现有 GPU HDR panorama→prefilter、资源准入、gpuValidatedStage、Vitest/Playwright/Three 可复用；不加运行依赖。
4. 已读 PbrMainBindings、stageEnvironment→PbrEnvironmentState、StudioDeepEnvironmentSession/Source、viewerEngineRig.setSceneEnvironment 与 SceneEnvironmentPanel.onEnvironmentChange 消费路径。
5. 现有 parallax CPU/checksum 与 test-output/deep-core/C15/reflection-parallax-gpu.json 已有核证据；生产 shader/bindings/source/environment staging tests 可扩展。旧核结果不重做算作新接线证据。
6. 权威剩余清单、09-30 handoff/恢复台账与 remaining estimates 已校准：C15真实余项为生产shade、双cube、编辑配置与跨界过渡。

已有（不重建）：盒投影/权重单源、CPU镜像、64B record、AABB来源、HDR预滤波、帧边界环境准备/提交/回滚/取消/资源准入、Studio环境编辑/快照保存。

真实缺口：实际specular IBL片元调用、最多两探针cube绑定、场景作者配置与真实边界过渡画面。没有独立捕获平台/全局探针缓存。

## 接线方案与文件锁

- 独立 leaf `pbrReflectionProbes.ts/.test.ts`：沿现有record打包两条128B，空槽影响半径0；两个cube绑定默认alias现有环境specular，不创建兜底纹理、不拥有alias资源。组合 owner 去重释放，随现有环境事务代际变化。
- 待主线释放 C8 共享生产缝：pbrShader/pipelines/PbrMainBindings/PbrEnvironmentSource/StudioEnvironment/PbrPipelineSet。Web专用frame group0追加两cube与独立uniform，Frame/Mesh数据ABI保持既有结构。
- 最多两探针、相同已解码源同一次上传/准备；本刀不做全局缓存。预滤波复用现有环境 WGSL，探针只保留specular cube，不重复生成diffuse/BRDF LUT。
- 生产宿主 source 准备失败/取消/epoch失效沿既有 AbortSignal 与 PbrEnvironmentState，候选销毁、旧有效帧保持、成功新帧提交后释放旧owner。新cube与主环境的owner一起处理，不让裸view越过epoch。
- 编辑配置沿 SceneEnvironmentState additive字段、sceneValidation与onEnvironmentChange；新增折叠 ReflectionProbeEditor 复用现有环境面板/资源选择器与样式令牌。viewerEngineRig.setSceneEnvironment→作者scene.userData保存探针元数据，StudioDeepEnvironmentSource读取已有像素并加入身份比较；不新建URL下载通道/状态仓。

## 验证约定

空配置默认实际帧前后等值；1/2探针、壳层过渡、盒内/盒外、无覆盖、非法盒、失败/取消/重开/环境替换为有效范围。GPU入口必须调用实际PbrRenderer并记录资源/当前epoch/有效首帧，场景无覆盖沿原环境。固定预算至多2cube，不将CPU误差当GPU收益。

设计读题：Unity盒投影局部反射与Studio深色工程语言；令牌唯一apps/web/src/styles/base.css。用户指定视觉两轮深色1920×1080；数值附件尺寸依核合同。10维评分与跨界画面在实机后记入，leaf通过不算整项完成。

状态：本刀已完成。生产 shader/bindings/source、场景合同/编辑配置、作者像素投影及真实 GPU/编辑器两轮均通过。`pbrShader.ts` 由 C8 后续独占，本刀只维护独立 host helper。

## 本轮检查

- 生产新增两 cube + 128B 独立记录绑定；空配置两个 cube alias 基础 specular。空半径在片元直接返回原全局采样，不做局部核计算或纹理上传。
- 环境切换固定两个 128B uniform buffer 轮换；候选 bind/upload 成功后才替换当前 binding，失败维持旧记录与旧画面。默认/发布/失败重试新增两个回归，聚焦引擎五文件 45 通过、2 既有 skip。
- 探针预滤波仅生成 specular mip cube，借用基础 diffuse/BRDF/sampler；相同源候选内复用，最多两 cube。owner 去重、取消/失败/提交回滚沿既有环境事务；没有跨设备缓存。
- 作者配置沿 SceneEnvironmentState 与已有环境面板保存，继承源复用已加载像素，URL 候选去重。坏来源身份每个变更只报告一次，20 次连续 view 不重试；来源改变自动重试。作者层五文件 31 通过。
- Native/WASM 运行包现有未知环境字段门拒绝 reflectionProbes，保留 environment deferred；本刀不宣称这两个宿主有局部探针消费。
- 独立实际生产 PbrRenderer 门 `iC15ReflectionProbeProduction.ts` 与 `scripts/i-c15-production-reflection.mjs` 已准备、lab 类型通过；无替代光栅。双轮深色 1920×1080 检查空配置、两探针、平面控制、无覆盖、取消/非法盒/提交失败恢复、资源回收及盒边过渡，实机结果见最终证据。

## 编辑器实际负例

实际 DOM 门 `reflection-probe-editor-t2q8LJ` 已验证配置保存/重载、两探针预算、禁用保持、零尺寸保持旧值；中心输入 1e12 仍进入作者状态，超过场景合同 ±1e9。已有 HTML min/max 不承担 React 状态校验。修复锁仅 SceneReflectionProbeEditor.tsx/.test.tsx，补中心/半尺寸/距离三类上下界，与 sceneReflectionProbes 合同一致；实际 callback 回归覆盖非法/NaN/无穷与 inclusive 边界。最终统一构建后 GhpsfR 两轮通过。

## 最终证据

生产证据：`test-output/i-series-0930/reflection-probes/evidence.json`，两个独立 browser context/device realm，深色1920×1080，NVIDIA Lovelace。每帧实际 capture pass 为 opaque→present，2 draw/3 triangles；中性作者 grading 选择既有完整 HDR 路径，不添加 AA 或其他效果。最初无后处理配置选择了直显示快路，opaque-hdr 未写；该历史零读回不是盒体未绘制，最终门保留严格非零/差异断言并检查实际 pass。

两轮 shader hash `6cc13053306df85a4a4a17bf0ed7bb689b6d6adba1d6eab0e80f33ce135b7b7b`，bundle SHA-256 `80b98c1bf1b618e0e5693e096cf761cab823de3b838ae94ca747fb0bf7093d98`。sourceFresh=true，证据包含10个源哈希，当前 host/shader 与证据一致；device epoch=0且结束仍为同一 device。

- 两探针改变815364像素；盒投影对平面控制改变813382像素，HDR值均有限。盒边在作者 blendDistance 内渐退到既有平面哨兵方向，仍每参与探针仅一次 cube 采样；blendDistance=0 保留作者硬切选择，canonical 核/record不变。
- 两个单探针与全局实际帧，独立按 CPU canonical 权重还原11个组合点，最大RGB误差0.000120263；中心120对相邻像素最大差0.00830078125。包含无覆盖、单主导、重叠和左右壳层样点，不以变化像素数代替权重验证。
- 空配置、无覆盖、候选取消、非法盒拒绝、queue.submit失败回滚、恢复全局均与基础帧逐值等同，maxError=0。
- 资源54→56→54，最多两 local specular cube；销毁后0，GPU validation与session诊断均空。CPU回归同时覆盖相同source候选一次上传、共享owner去重、失败/取消/新旧epoch回收与inactive记录提交。

编辑器证据：`test-output/runs/2026-09-05/reflection-probe-editor-GhpsfR/report.json`，深色1920×1080两个 fresh context均通过，页面异常为空。实际UI创建场景，添加/修改/禁用探针，保存workspace、重载、再保存，配置逐项保持；第三个添加禁用、零尺寸和中心1e12保留旧有效值。App bundle SHA-256 `1748e1a3f2bb7878a7f5b0629d5f8015ab7d13af895f2f7d87ee46b3cb6fcd7d`。

已目视 r1-configured 与 r2-reloaded-disabled-validated：原先 probe 名称竖排与XYZ伸出面板已修；header/三轴/米单位/继承来源/禁用状态沿原令牌。面板宽386px，x=1213，右界1599；内容604.8px随既有环境工具窗纵向滚动，未将可滚动内容要求为全部同时显示。生产两轮盒边图的细竖带已消除。同族检查覆盖向量三轴、距离两个字段、两slot与正常/失败环境候选。

对标：Unity局部盒投影/相邻探针混合，Studio原环境工具窗的信息密度。10维自评（本刀新增入口及反射效果）：层级9.5、一致性9.6、间距9.5、中文9.5、对比9.5、操作9.6、反馈9.5、布局9.5、3D视觉9.5、性能9.6，平均95.3/100。

检查：引擎聚焦7文件51测通过；作者聚焦5文件31测通过，最终新增控件3测通过；lab/Web类型通过。主线最终共享链9文件71通过/3既有skip、作者3文件9通过、engine→Web构建和runtime freshness通过。Native/WASM仍保持既有显式环境deferred，本刀范围为Deep WebGPU生产及Studio作者配置。

## Harvest 文件

以下37文件属于本刀；pbrShader.ts与C8共享，由主线统一收割。test-output为本地实测附件。

```text
packages/contracts/src/scene.ts
packages/contracts/src/sceneValidation.ts
packages/contracts/src/sceneReflectionProbes.ts
packages/contracts/src/sceneReflectionProbes.test.ts
packages/deep-engine/src/webgpu/pbrShader.ts
packages/deep-engine/src/webgpu/pbrReflectionProbeWgsl.ts
packages/deep-engine/src/webgpu/pbrReflectionProbes.ts
packages/deep-engine/src/webgpu/pbrReflectionProbes.test.ts
packages/deep-engine/src/webgpu/pbrReflectionProbePreparation.ts
packages/deep-engine/src/webgpu/pbrReflectionProbePreparation.test.ts
packages/deep-engine/src/webgpu/reflectionProbeSpecularEnvironment.ts
packages/deep-engine/src/webgpu/reflectionProbeSpecularEnvironment.test.ts
packages/deep-engine/src/webgpu/pbrMainBindings.ts
packages/deep-engine/src/webgpu/pbrMainBindings.test.ts
packages/deep-engine/src/webgpu/pbrEnvironmentSource.ts
packages/deep-engine/src/webgpu/pbrPipelineSet.ts
packages/deep-engine/src/webgpu/pipelines.ts
packages/deep-engine/src/webgpu/pipelines.test.ts
packages/deep-engine/src/webgpu/studioEnvironment.ts
packages/deep-engine/src/webgpu/index.ts
packages/deep-engine/src/threeBridge/deepWebGpuOptions.ts
packages/deep-engine/lab/iC15ReflectionProbeProduction.ts
scripts/i-c15-production-reflection.mjs
apps/web/src/components/SceneEnvironmentPanel.tsx
apps/web/src/components/SceneReflectionProbeEditor.tsx
apps/web/src/components/SceneReflectionProbeEditor.test.tsx
apps/web/src/styles/scene-environment.css
apps/web/src/viewer/StudioDeepEnvironmentSession.ts
apps/web/src/viewer/StudioDeepEnvironmentSession.reflectionProbes.test.ts
apps/web/src/viewer/studioDeepEnvironmentSource.ts
apps/web/src/viewer/studioReflectionProbeCarriers.ts
apps/web/src/viewer/studioReflectionProbeCarriers.test.ts
apps/web/src/viewer/viewerEngineEnvironment.ts
apps/web/src/viewer/viewerEngineLifecycle.ts
apps/web/src/viewer/viewerEngineRig.ts
apps/web/scripts/gate-reflection-probe-editor.mjs
docs/specs/i-c15-production-box-reflection-20260930.md
```
