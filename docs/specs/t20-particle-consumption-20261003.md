# T20 粒子系统:deep-engine 能力 → 编辑器消费接入(2026-10-03)

> 范围:把 `packages/deep-engine/src/particles/*` 已有的曲线、预算能力接入编辑器唯一的粒子发射器(模型"火焰图层",
> `SceneModelEffectsState.fire`),补齐引擎侧缺的透明排序与曲线 LUT,并在属性面板暴露曲线与预算。
> 来源:`omission-audit-20261004.md` T20 行(疑似错误关闭)、`handoff-remaining-tasks-20261004.md` T20。

## 1. 现状核查(六步结论)

核查范围:`packages/deep-engine/src`、`packages/contracts/src`、`apps/web/src/{viewer,components,studio,delivery}`;
`git status --short | grep -i particle` 无他人粒子相关未跟踪/改动(接续无冲突)。

### 已有(不重建)

| 能力 | 位置 | 说明 |
|---|---|---|
| 曲线求值器(关键帧线性、钳制、生命周期归一) | `deep-engine/src/particles/particleCurves.ts` | `createParticleCurve`/`evaluateParticleCurve`/`evaluateParticleCurveOverLife`;唯一公式源 |
| 预算计划 + 3 级降级 | `particles/particleBudget.ts` | `planParticleBudget`(最大余数法分配、显存证据、`degradationReasons`)、`enforceParticleCapacity` |
| 事件/统计/烟体/流场 CPU 参考 | `particles/particleEvents.ts`、`particleStats.ts`、`smokeDiffusion.ts`、`flowFieldParticleCpu.ts` | 本任务不动 |
| GPU 粒子运行时 + billboard Pass | `webgpu/gpuParticleRuntime.ts`、`pbrParticlePass.ts`(已接 PBR 帧循环) | 加色(max)/预乘 alpha 两条管线;**无排序、无曲线** |
| 编辑器发射器 | `apps/web/src/viewer/modelFireEffect.ts`(单个 THREE.Points,80×density 粒子) + `ModelEffectsEditor.tsx`(颜色/强度/高度/密度) | 全程固定尺寸/固定颜色/固定透明度,无预算,无排序 |
| 契约 | `contracts/src/scene.ts#SceneFireEffectState` + `sceneValidation.ts#validateModelEffects` | 仅 enabled/color/intensity/height/density |
| 归一/合并 | `viewer/modelEffectState.ts`(`normalizeFireEffect`/`mergeModelEffectsPatch`) | 嵌套合并已保护作者参数 |
| 引擎接线点 | `viewerEngineRendering.ts#rebuildModelEffects/updateModelEffects`、`viewerEngineRig.ts#setModelEffects` | 唯一创建/更新/销毁路径 |

### 真实缺口(本任务实现项)

1. `particleCurves`/`particleBudget` **零消费方**(grep 仅 deep-engine 自身与测试);且 `@bim-studio/deep-engine` **无 `./particles` 子路径导出**,
   apps/web 无法引用 → 补 package exports。
2. 引擎**没有透明排序实现**(`pbrParticlePass.ts`/`gpuParticle*` 无 sort,全仓无 back-to-front)。"走引擎已有实现"不成立,
   故先在引擎补 `particleSort.ts`(计数排序,O(n) 稳定确定性),编辑器再消费。
3. 曲线只有关键帧求值,逐粒子逐帧求值开销与分配不可接受 → 引擎补 `particleCurveLut.ts`(烘焙 + O(1) 采样)。
4. 编辑器发射器缺 size/color/alpha over lifetime、预算(单发射器 + 场景总量)与降级可见提示、混合模式选择。
5. 属性面板没有曲线编辑与预算读数。

### 本任务不做(遗留,写入 §4)

- `PbrParticlePass`(GPU 路径)的 GPU 排序核、曲线 LUT 纹理采样、事件读回、烟体接线、实机阶梯 → T20-A/C 余量。
- WebGPU 渲染器下 THREE.Points 逐粒子尺寸(PointsNodeMaterial)→ 退化为曲线均值全局尺寸。

## 2. 设计

- **引擎(新增,零新依赖)**:`particleCurveLut.ts`(`bakeParticleCurveLut`/`sampleParticleCurveLut`)、
  `particleSort.ts`(`sortParticlesBackToFront` + 复用型 scratch);`particles/index.ts` 导出;`package.json` 增 `./particles`。
- **契约**:`SceneFireEffectState` 增可选 `curves`(size/alpha/color,关键帧 `{time,value}`,最多 16 键)、
  `blend`(`additive`|`alpha`)、`maxParticles`(单发射器上限);全部可选 → 旧场景零迁移。校验同步。
- **曲线语义**:size = 相对基准尺寸倍率(0..4);alpha = 0..1;color = 热度 0..1(0=余烬暗色 → 0.5=基色 → 1=高光),
  逐粒子按 age/lifetime 查 LUT。缺省曲线 = 火焰默认(淡入、中段峰值、尾部消散)。
- **预算**:单发射器 `min(round(80×density), maxParticles)`;场景总预算 `SCENE_FIRE_PARTICLE_BUDGET = 1024`,
  经引擎 `planParticleBudget` 分配(最大余数法);超限只缩 `drawRange` 与更新循环,**不崩溃、不重建几何**。
  纯函数 `planSceneFireBudget` 由引擎运行时与 UI 共用,保证所见即所得。
- **排序**:仅 `blend: "alpha"` 时每帧 `sortParticlesBackToFront`(相机转模型局部坐标),加色混合顺序无关,跳过。
- **UI**:`ModelEffectsEditor` 火焰区增:混合模式、粒子上限、预算读数条(单发射器/场景,超限 `role=status` 警示)、三条曲线编辑器
  (SVG,拖拽/键盘调整/双击删点/点击加点,预设)。令牌取 `base.css`,强调色 `color-mix(var(--accent))`,无 hardcode。

## 3. 实施结果(2026-10-03)

### 改动清单

| 层 | 文件 | 内容 |
|---|---|---|
| 引擎 | `deep-engine/src/particles/particleCurveLut.ts`(+test) | `bakeParticleCurveLut` / `sampleParticleCurveLut`:关键帧曲线烘焙为 64 点 LUT,逐粒子 O(1) 读表 |
| 引擎 | `deep-engine/src/particles/particleSort.ts`(+test) | `sortParticlesBackToFront` 计数排序(O(n)、稳定、确定性、复用 scratch);误差 ≤ 距离范围/bins |
| 引擎 | `particles/index.ts`、`deep-engine/package.json` | 导出新 API;新增 `./particles` 子路径(此前 apps/web 无法引用) |
| 契约 | `contracts/src/scene.ts`、`sceneValidation.ts`(+test) | `SceneFireEffectState` 增可选 `curves`(size/alpha/color,≤16 键)、`blend`、`maxParticles`;校验值域/严格递增/键数 |
| 编辑器 | `viewer/modelFireParticles.ts`(+test) | 曲线清洗与烘焙(走引擎 `createParticleCurve`+LUT,非法回退默认)、单发射器申请量、场景预算 `planSceneFireBudget`(走引擎 `planParticleBudget`,64 发射器上限外降为 0 而非抛错) |
| 编辑器 | `viewer/modelFireEffect.ts`(+test) | 逐粒子 size(WebGL `aSizeScale`,WebGPU 退化为曲线均值)/alpha(RGBA 顶点色)/热度色;alpha 混合每帧引擎排序;`setModelFireAllocation` 仅缩 drawRange 与更新循环 |
| 编辑器 | `viewer/modelEffectState.ts`(+test) | `normalizeFireEffect` 清洗 curves/blend/maxParticles,缺省不写键 |
| 编辑器 | `viewerEngineCore/Rendering/Contract.ts`、`viewerEngineFireBudget.test.ts` | `getParticleBudgetReport()`;集合变化(创建/销毁)置脏位,当帧 `rebalanceFireBudget`;相机位置传入排序 |
| UI | `components/ParticleCurveEditor.tsx`、`ModelEffectsEditor.tsx`(+test)、`ObjectAppearanceEditor.tsx`、`views/AppStudioInspector.tsx`、`styles/platform-components.css` | 三条曲线编辑器(拖拽/方向键/双击增删/Delete/预设/恢复默认)、混合模式、粒子上限、预算读数 + 超限 `role=status` 警示;令牌取 `base.css`,强调色 `color-mix` 派生 `--accent` |
| 文档 | `apps/web/src/docs/deep-engine-sdk.md` | 补 `./particles` 子路径说明 |

### 验证结果

- `deep-engine`:`npx tsc --noEmit` exit 0;`vitest run src/particles` 9 文件 / 58 用例通过(含新增 LUT 与排序)。
- `contracts`:`tsc --noEmit` exit 0;全量 vitest 51 文件 / 473 用例通过(新增曲线/混合/上限校验 8 例)。
- `apps/web`:`npx tsc --noEmit -p .` 本任务相关文件 0 错误(合并时全仓出现 `PathTraceAuthorDialog.test.tsx` 7 处类型错误,来自他人在途改动,与粒子无关);
  相关 vitest(modelFireParticles / modelFireEffect / modelEffectState / viewerEngineFireBudget / ModelEffectsEditor / ObjectAppearanceEditor / studio / docs)全部通过。
  较大回归 `src/viewer src/studio src/components src/scripting`:3289 通过,2 失败 + 3 套件无法加载,均与粒子无关且文件未被本任务改动:
  `StudioDeepWebGpuBridge.test.ts`(frames.size 计数,单跑同样失败)与 `ProfessionalCodeEditor`/`professionalCodeTypeCheck`/`SceneBehaviorPanel`(`window is not defined`,Monaco 环境)。
- 浏览器实测(Chrome,1920×1080,深色):三维编辑器选中立柱 → 属性检查器启用火焰 → 三条曲线、混合、预算读数渲染正确;
  拖拽关键帧(size 44%/1.85)、方向键(alpha 0.70)、双击加点(3→4)、Delete 删点(4→3)均生效;切换"透明·排序"后粒子由加色火星变为带 alpha 的软烟状,画面无报错。
  降级态(10 发射器 × 160 → 场景预算 1024,实配 64%)用同一组件+`base.css`/`platform-components.css` 渲染截图,警示条与琥珀色边框可见。
  截图:会话 files 目录 `t20-r1-*.png`、`t20-r2-*.png`、`t20-degraded.png`。

### 遗留(未做,按价值排序)

1. **GPU 路径(`PbrParticlePass`)** 仍无排序核、曲线 LUT 纹理采样、事件读回、烟体接线、实机阶梯 → 对应审计 T20-A/C 余量;本次引擎侧 LUT/排序为 CPU 基线,可作为 GPU 核的字节对照参考。
2. **WebGPU 渲染器**下 THREE.Points 无逐粒子尺寸(节点材质不支持 `onBeforeCompile`),size 曲线退化为均值全局倍率;需 `PointsNodeMaterial`/Sprite 实例化方案。
3. 场景总预算 1024 为常量(`SCENE_FIRE_PARTICLE_BUDGET`),尚无项目级设置入口;`maxParticles` 契约上限 512,运行时归一到 160(与 80×密度 2 对齐)。
4. 曲线编辑器无 DOM 单测(仓库无 testing-library/jsdom),交互由浏览器实测覆盖;浅色主题按任务约定未测。
5. 火焰面板原有硬编码橙色底(`.fire-effect-editor` 等旧规则)未改,仅新增部分全部令牌化。