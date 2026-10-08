# Deep 材质缺口补齐:sheen / iridescence / 体积透射 / clearcoat 桥放行(2026-10-03)

对标 Unity HDRP / UE / Babylon PBR,使 three r185 `MeshPhysicalMaterial` 与 Deep(WebGPU)在 sheen、iridescence、透射厚度/衰减、clearcoat 上一致。
来源:`omission-audit-20261004.md` §2 C(T08/T09 scope-lock 余项,"aniso/transmission IBL 核已有,补 IBL 分支+双端对拍")与 `handoff-remaining-tasks-20261004.md` 第 5 项。

## 2026-10-07 后续修复

本文记录10月3日的实现基线。后续已补生产不透明场景颜色透射，以及 KHR_materials_specular 两种因子/贴图的导入、Three桥、Browser packet和GPU消费；高级材质uniform现在为320B，关闭能力仍为192B。静态与真实morph姿态的高光遮罩、UV1、强度0和金属分支8项真实GPU探针通过。Native运行包与RT path-tracing尚未支持该specular合同，仍明确拒绝非中性输入。最新源码、图片和逐文件证据见 [SMT高光贴图核查](studio-source-specular-audit-20261007.md)；整场画质一致性由SMT同相机回归继续验收。

## 1. 现状核查(动手前)

### 已有(不重建)
| 能力 | 位置 | 说明 |
|---|---|---|
| 扩展参数块(ior / clearcoat / 各向异性 / 薄壁透射) | `packages/deep-engine/src/shader/materialParameters.ts`、`materialParameterAbi.ts`、`wgsl/materialEvaluateCore.wgsl` | 6 float 带,材质 uniform 40..46;CPU 黄金 + WGSL 核共用,checksum 钉死,与 native 共享 |
| clearcoat 直射(Khronos) + 白炉/转移恒等真机 gate | `lab/clearcoatFurnaceGpuProbe.ts`、`scripts/clearcoatFurnaceGpuTest.mjs` | 仅**直射项**;无 IBL 清漆反射;无纹理材质被拒 |
| 白炉真机框架 | `lab/whiteFurnaceGpuProbe.ts`、`src/webgpu/whiteFurnace.ts` | 本次直接复用 `uniformFurnaceEquirect / decodeFurnaceColor / furnaceSphereSegmentation` |
| glTF 映射 clearcoat / anisotropy / transmission / ior | `src/shader/materialGltfMap.ts`、`gltf/decodeTexturedGltf.ts` | 无核心纹理的材质被丢弃并记 `material-profile-unsupported` loss |
| 选择性管线变体机制 | `pipelines.ts`(`layeredMaterials` + `composeLayeredMaterialSceneShader`)、`pbrPipelineSet.ts` | 本次沿用同一"按需编译 + replaceOnce 锚点"模式 |
| three 对拍基建 | `lab/c8SharedSceneProbe.ts`、`apps/web/src/viewer/threeMaterialMath.ts`、`threeDirectMaterialProfile` | 真 WebGL three + 生产 `DeepWebGpuBackend` |
| contracts `SceneMaterialState.ior` | `packages/contracts/src/scene.ts`、`sceneValidation.ts` | 本次字段扩展的先例 |

### 真实缺口
1. `sheen / iridescence / attenuation / thickness` 在 `deep-engine/src|wgsl`、`contracts/src` 全仓零命中(`volumetricFog` 等同名不同义除外)。
2. clearcoat 无 IBL 项;扩展材质必须有核心纹理(untextured 的 three 物理材质无处承载)。
3. `ThreeProjectionBridge` 对任何非中性 `MeshPhysicalMaterial` 一律 `unsupported("MeshPhysicalMaterial non-neutral extensions")`——clearcoat/sheen/… 的 three 材质无法进 Deep。
4. 材质 uniform(192B,40..47 仅余 2 float)装不下 12 个新参数;texture-array 行布局(`MATERIAL_ARRAY_TABLE_ROW_BYTES`)与 native ABI 绑定在 192B 上。

## 2. 设计

**contracts 先行**(`packages/contracts/src/scene.ts` + `sceneValidation.ts`,dist 已重建):`SceneMaterialState` 增 `clearcoat / clearcoatRoughness / sheen / sheenRoughness / sheenColor / iridescence / iridescenceIOR / iridescenceThicknessMax / transmission / thickness / attenuationColor / attenuationDistance`(three r185 语义、缺省=中性,范围 fail-closed,`attenuationDistance` 缺省=无穷)。测试:`sceneValidation.test.ts`。

**引擎参数**:`src/shader/materialAdvancedParameters.ts`(`AdvancedMaterialParameters`:sheen{color,roughness} / iridescence{factor,ior,thickness} / volume{thickness,attenuationColor,attenuationDistance};归一化 fail-closed;12 float 打包,`attenuationDistance=Infinity↔0` 哨兵)。6 float 扩展块与 native 共享 WGSL **一字未动**。

**选择性变体 `advancedMaterials`**(`PbrRendererOptions.advancedMaterials`,缺省 false,**不改 `pbrRendererFeatures.ts`**):
- 未启用:场景 WGSL 与原版字节一致(`pbrShader.ts`/`pbrDeformationShader.ts` 零改动,测试断言不含 `deepAdv`),材质 uniform 仍 192B。
- 启用:`composeAdvancedMaterialSceneShader` 仅三处 replaceOnce 锚点 —— `MaterialTextures` 增 `advanced0..2`(→240B);`shade` IBL 的 `f0` 接入薄膜 F0(`mix(f0, iridF0, 0)` 恒等,普通材质逐位不变);`extendedShade` 改为派发器(无高级 lobe 时走原 `deepLegacyExtendedShade`)。管线键、`MaterialLayouts.advancedMaterials`、中性纹理承载、texture-array 批次回退常规路径均已接线;与 layered/textureArrays 互斥(fail-closed)。
- Studio:`apps/web/src/viewer/studioDeepAdvancedMaterials.ts#sceneUsesDeepAdvancedMaterials` 仅当场景含**激活** lobe(判定同 three `refreshUniformsPhysical`:标量>0)才在 `StudioDeepWebGpuBridge` 打开变体与投影能力,其余场景零开销。

**数学(逐式对齐 three r185,`materialAdvancedWgsl.ts`)**
- sheen:`D_Charlie`、`V_Neubelt`、`IBLSheenBRDF` 曲线拟合;直射 `energy = 1 − max3(sheenColor)·max(A(nv),A(nl))`,间接 `1 − max3·A(nv)`;`sheenColor×sheen` 在桥里相乘(three 同)。
- iridescence:Belcour–Barla 薄膜 `evalIridescence`(含 TIR、`smoothstep(0,0.03,d)` 强制退化、2 阶 Fourier 光谱 → XYZ→Rec709)、`Schlick_to_F0`;直射 `F=mix(F, iridFresnel, irid)`,IBL `Fr=mix(f0, iridF0, irid)`(沿用 `shade` 的 split-sum 能量分配,故白炉恒守恒);dielectric/metal 双求值仅在 `0<metal<1` 时都算。
- 体积透射:`refract(-v,n,1/ior)` 方向采样环境(`deepPbrReflectionRadiance`,LOD 随 `roughness·clamp(2·ior−2,0,1)`),`(1−F)·diffuse·Beer(thickness)·radiance`,`totalDiffuse = mix(totalDiffuse, transmitted, transmission)`(three `transmission_fragment`);Beer 即 `volumeAttenuation`。
- clearcoat:three `BRDF_GGX_Clearcoat` 直射 + IBL(`0.04·dfg.x+dfg.y`)+ `out·(1−cc·Fcc)+coat·cc`。

**桥**:`ThreeProjectionBridge` 新增 `capabilities.advancedMaterials`;开启后 `MeshPhysicalMaterial` 的 clearcoat / sheen / iridescence / transmission+thickness+attenuation(无贴图)投影为 `extendedParameters` + `advancedParameters`,贴图、各向异性、色散、specular 扩展仍 fail-closed;未开启时合同不变(原测试保持)。`DeepWebGpuBackend` 的 renderer 选项白名单已加 `advancedMaterials`。
**glTF**:`decodeTexturedGltf({ advancedMaterials: true })` 把 `KHR_materials_sheen / iridescence / volume`(+既有 clearcoat / transmission)映射进来,允许无核心纹理材质,对应"回退"loss 被抑制,贴图输入记 `material-texture-unsupported` loss。

## 3. 实施结果

| 步骤 | 交付 | 证据 |
|---|---|---|
| ① sheen | WGSL + 参数 + 打包 + 变体接线 | 真机:球白炉灰 sheen ≡E(min/max=1.0000);彩色 sheen 对解析预测 p95=5.1e-4、max=9.3e-4(相对 E);直射对 CPU 预测 absP95≈2e-4 |
| ② iridescence | WGSL 薄膜 + IBL F0 接入 | 数学对拍 worstRel=1.1e-3;白炉守恒 =1.0000;直射增量对 CPU 预测 absMax=2.4e-4(tilt 0/25) |
| ③ 透射厚度/衰减 | 环境折射 + Beer + 参数 | 衰减比 `(att−noatt)/(E·(A−1))` 三通道均值 0.950–0.951 = `1−F(≈0.05)`,范围 [0.888,0.961](A=0.38/0.92/0.57);白炉 transmission=1 ≡E |
| ④ clearcoat 放行 | 桥映射 + untextured 承载 + IBL 清漆 + glTF 无纹理 | 直射 absMax=4.5e-4;白炉 mean=0.9984(≤1,min 0.9971);three 对拍 relRMSE 0.10% |

**three r185 ↔ Deep 真 GPU 对拍**(`scripts/advancedMaterialThreeParityTest.mjs`,真 WebGL three + 生产 `DeepWebGpuBackend`,直射无环境,线性 HDR,320×192,RTX 4060):stock RMSE=8.4e-5(两端均值亮度 0.1538);特性增量 `(feature−stock)` 相对 RMSE:sheen 0.09%、iridescence 2.70%(maxAbs 5.1e-2,集中在少数像素,未深究根因)、iridescence-metal 0.32%、clearcoat 0.10%、组合 0.14%。
**白炉/解析真机**(`scripts/advancedMaterialGpuTest.mjs`,37 腿):stock off≡adv 位级 0;untextured≡textured 位级 0;所有 gate PASS。截图 `test-output/advanced-material-gpu-20261003/showcase.png`(sheen 天鹅绒 / 薄膜金属 / 清漆车漆 / 带衰减玻璃),证据 `evidence.json`、`three-parity.json`。
帧耗时(960² 球、无回读、3 轮中位数取最小,RTX 4060):advanced 变体下普通材质 +0.012 ms;各特性相对变体普通材质 sheen +0.056 / iridescence +0.044 / clearcoat +0.041 / 透射 +0.076 ms。未启用变体 = 原管线,耗时/字节无变化。

## 4. 体积(esbuild minify,`conditions: development`)

| 项 | 前 | 后 | Δ |
|---|---|---|---|
| stock `sceneShader` WGSL | 113,205 B | 113,205 B | **0**(未改) |
| advanced 变体 WGSL | — | 123,522 B | +10,317 B(gzip 29,107 → 31,660,+2,553 B),**仅启用变体的管线**编译 |
| 新增 WGSL 文本 | — | 10,211 B(其中纯数学 3,882 B,可独立编译) | — |
| 材质 uniform / 材质 | 192 B | 192 B(stock)/ 240 B(advanced 变体) | 池化,每唯一材质 +48 B,仅变体 |
| `src/index.ts` minify 包 | 1,489,074 B(gzip 523,951)@`e59ce4df` | 1,495,348 B(gzip 525,620) | +6,274 B(+1,669 gz;含并行子智能体同期改动,非纯本任务) |

未新增依赖。`dist` 仅重建 contracts(`npx tsc -p .`);deep-engine 经 `development` 条件走 src,未重建其 dist。

## 5. 测试

- `cd packages/deep-engine && npx tsc --noEmit` 无错;`tsconfig.lab.json` 中本任务文件无错。
- `npx vitest run src/webgpu src/shader src/gltf src/threeBridge src/runtimePackage`:3331 通过;1 项失败为 `materialMetalReflectionSampling.test.ts`(6.9 s CPU 积分用例超时,与本任务无关)。
- 新增单测:`shader/materialAdvancedParameters.test.ts`(参数 + three 参考数学性质)、`webgpu/pbrAdvancedMaterialShader.test.ts`(组合锚点 / 静态+变形 / stock 不变 / 192↔240B 打包)、`threeBridge/ThreeProjectionBridge.advancedMaterials.test.ts`、`threeBridge/deepWebGpuOptions.advancedMaterials.test.ts`、`gltf/decodeTexturedGltf.advancedMaterials.test.ts`、contracts `sceneValidation.test.ts`、`apps/web/.../studioDeepAdvancedMaterials.test.ts`。
- `apps/web`:`npx tsc --noEmit -p .` 0 错;`src/viewer/StudioDeepWebGpuBridge*` + 新测 83 通过。
- 真机:`npm run test:advanced-material-gpu`、`npm run test:advanced-material-three-parity`(Chrome WebGPU,NVIDIA RTX 4060)均 PASS。
- 观察:并行子智能体把 `contactShadows` 默认改为 true,会压暗无灯白炉球边缘;本探针显式 `contactShadows:false`(`vignette:false`)。

## 6. 遗留 / 已知差异

1. **贴图 lobe**(sheen/iridescence/clearcoat/transmission/thickness 的 map)未支持:桥 fail-closed,glTF 记 `material-texture-unsupported` loss。
2. **各向异性**(three)仍拒绝;advanced 变体下 aniso 与高级 lobe 同时出现时 aniso 被丢弃(仅无高级 lobe 时走原 legacy 路径)。
3. **透射**为环境折射,不采样场景不透明物 RT(three 的 `transmissionSamplerMap` 含其它物体);thickness 视为世界单位(未乘模型缩放);无 dispersion;advanced 变体用体积折射替代 legacy 薄壁透射瓣。
4. 仅主太阳光得到 sheen/iridescence/clearcoat 直射项;Forward+ 点/聚光走 stock BRDF(与既有 legacy 扩展路径一致)。
5. IBL 项只做了解析(白炉)与自洽验证;three PMREM 环境与 Deep 预滤波环境未对齐,故 three 对拍限于直射。
6. Studio:变体在 backend 创建时按场景判定;之后新增激活 lobe 的材质会被桥 fail-closed 拒绝,需重建 backend。`SceneMaterialState` 新字段仅有合同/校验,编辑器 UI、持久化到 three 材质(类似 `materialIor.ts`)未接。
7. 未写入 `rendererCapabilityManifest`(需同步 fixture 与 selfCheck);native(Rust)与 runtime package(`renderPacketBrowserMaterial`)未携带 `advancedParameters`。
8. 白炉下 clearcoat 略低于 1(mean 0.9984):three 公式 `1−cc·Fcc(nv)+cc·(0.04·dfg.x+dfg.y)` 的固有差,非能量创造。
