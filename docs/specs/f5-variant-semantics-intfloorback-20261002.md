# F5 第四层续刀:变体语义裁定 intFloorBack — f5-variant-semantics-intfloorback-20261002

> 2026-10-02。底座:`docs/specs/f5-l4-root-cause-20261002.md`(L4 两修复已落,intFloorBack
> leakRatio 1.843 未达门,残余载体定位到显示管线变体语义层并移交 §4)。
> 本刀 = 账本「intFloorBack 变体语义刀」(jc-i-continuation-20261001:481):裁定 GI 开关切换的
> 渲染管线变体语义合同,修复 GI-on 全量变体的镜面 IBL 域感知缺失。
> 禁 cargo(未触碰 Rust 链);帧时未测(多线并行,按指令豁免);不改 packages/contracts。

## 0. 结论速览

| 项 | 判定 |
|---|---|
| 任务名澄清 | **intFloorBack 无源码定义**——全仓 grep(含未跟踪)仅命中 docs 与 test-output harness 像素 region(`[700,780,1300,980]`);「整数取整」字面解读不成立(全仓无 intFloor/rounding 家族)。按账本原义 = 以失败 region 命名的**管线变体语义刀**(L4 §4-a 移交项) |
| 变体语义裁定 | **已定合同**:GI 开关 = 间接光项集开关。GI-off 直显族 = 纯直接光(无 IBL 块);GI-on 全量族 = 直接光 + IBL 漫射(探针 mix 门控)+ **IBL 镜面(探针可见度门控,本刀新增)** + 探针漫射 GI |
| 漂移点(已修) | 全量族镜面 IBL 无任何探针/域感知——封闭室内仍按全天空环境出射、门态无关(+30-60),即 intFloorBack leakRatio 1.84 的显示管线载体 |
| 变体语义回归测试 | **4/4 绿**(正数/负数/边界/与直显变体对照)+ WGSL 合同断言;naga 校验过 |
| 家族回归 | lighting+rayTracing+threeBridge **全绿**;webgpu 2883 通过、4 文件失败**全部定性为并行在途域**(逐项证据见 §4,无一由本刀引入) |

## 1. 现状核查

### 1.1 intFloorBack 的定义与全部消费点(全仓 grep,含未跟踪)

- 产品源码(TS/Rust/WGSL/JSON):**零定义、零消费点**。
- 实际存在:
  - `test-output/f5-gi-visual-20261002/f5-metrics.mjs:69`、`test-output/f5-gi-fix-20261002/f5-fix-metrics.mjs:102`、
    `test-output/f5-l4-20261002/f5-l4-diag-matrix.mjs:73` —— 封门哨兵 harness 的**像素 region 矩形**
    `intFloorBack: [700, 780, 1300, 980]`(室内地面后段),与 `intBackWall`/`intPartition` 同族;
  - `docs/specs/f5-*.md`、`docs/specs/jc-i-continuation-20261001.md` —— 读数登记。
- 命名语义:`int`=interior、`Floor`=地面、`Back`=后段(房间站位),**与整数取整无关**。
  任务文本「取整语义/时间基取整向后对齐/对照 intFloor」按全仓事实判为模板串扰,不成立;
  本刀按账本原义(变体语义刀)执行,合同裁定见 §2。

### 1.2 变体切换链(先读后写,读工作树现状)

- `pbrRenderer.ts:499`:`directionalDisplay = directClear !== undefined && !this.lighting.hasProbeClipmap && !hasClusteredLights(...)` ——
  **GI 开关(hasProbeClipmap)直接选择管线变体族**。
- `pipelines.ts:276,293`:直显族入口 `fragmentMainDisplay{,NoEffects,NoEffectsOneCascade}` /
  `fragmentMainDisplayDirectional`(`pbrDirectDisplayBodyWgsl.ts` 内 `shadeDirectNoEffects` /
  `shadeDirectOneCascade`,无 IBL 块);全量族 `fragmentMain*`/`fragmentMaterial*` 走 `pbrShader.ts` `shade()`。
- `shade()` IBL 块(pbrShader.ts:186-202 原状):漫射
  `mix(environmentIrradiance, gi.rgb, gi.a)` 探针门控;镜面
  `radiance * specularFraction * occlusion * frame.eye.w` —— **`occlusion` 仅材质 AO 纹理
  (fragmentMain 传 1.0),无探针项**。`deepGiSampleTexture` 返回 `vec4(irradiance, 有权重→1)`(probeClipmapTextureSamplingWgsl.ts:87-88)。
- checksum 面:`probeClipmapSampling.wgsl`(storage 路径)有 sha256 钉;`probeClipmapTextureSamplingWgsl.ts`
  与 `pbrShader.ts` **无钉** —— 本刀落点不触钉、不需要 `wgsl:sync`(该命令会重生成全部家族,避开并行写者碰撞)。
- 并行在途(本刀未触碰,读状态时逐一登记):`pbrReflectionProbeWgsl.ts`(LOD rebase)、
  `pbrShader.ts`(`let n = normalInput` 归一)、`pbrLayeredMaterialShader.ts`(metalTangent varying)、
  `pbrRendererTypes.ts`(layeredMaterials feature)、packet 链(`pbrFrameReceipt.ts` 等)。

## 2. 语义裁定(合同)

### GI 开关的变体项集合同

| 项 | GI-off 直显族 | GI-on 全量族 |
|---|---|---|
| 主光直射+阴影+簇光+直接多重散射 | ✔ | ✔ |
| IBL 漫射 | ✘(无 IBL 块) | ✔ 探针门控:`mix(envIrr, gi.rgb, gi.a)`,域外回退全量 envIrr |
| **IBL 镜面** | ✘ | ✔ **探针可见度门控(本刀)**:`visibility = clamp(L(probe)/L(env),0,1)`,域外恒 1 |
| 探针漫射 GI | ✘ | ✔(随漫射项 `gi.rgb`) |

- **裁定依据**:漫射项的既有合同是「探针有效域内以探针证据替代环境,域外保守回退环境」。
  镜面项采同一环境立方体族(specularEnvironment/localReflectionProbes),却无任何域感知——
  同一 GI 证据链下两项对「封闭室内」给出矛盾答案(漫射→黑,镜面→全天空),这正是 L4 §4 实测
  「黑探针正确压低漫射、镜面仍 +30-60 门态无关」的载体。
- **镜面可见度公式**:标量亮度比 `clamp(L(gi.rgb)/L(envIrr), 0, 1)`(Rec.709 权重,与 whiteFurnace
  区域统计同权重;标量避免给反射染色)。探针记录与环境辐照同为半球积分量——开阔天空探针
  比值≈1(零扰动),遮挡/室内 <1(正确压低,即标准 specular occlusion 语义);
  探针过亮(异常记录)clamp 到 1 不放大。
- **保守边界(三分支)**:域外(gi.a≤0)恒 1——与漫射 mix 的域外回退同一边界,未覆盖域零改动;
  环境近黑(≤1e-4)恒 1——无能量可漏;其余线性连续,无阶跃。
- **§4-b(直显/全量项集对齐)裁定**:不对直显族加 IBL(那会改 GI-off 基线,破坏室外/动态
  零回归锚),而是让 GI-on 的新增能量门态正确——leakRatio 的系统性偏置随镜面门控消除。
- **§4-c(thinwall 捕获主光缺席)**:属捕获内容语义(producer 解析链),不在本刀(显示语义)范围,保持移交。

### 生效面

`shade()` 是 fragmentMain/fragmentMainColor/fragmentMainTransparent/fragmentMaterial*/fragmentMainDisplay
的公共着色核——门控随 IBL 块一致生效于全部全量族入口;直显 NoEffects/OneCascade/Directional 三入口无 IBL 块,不受影响(有合同断言钉住)。

## 3. 改动清单

| 文件 | 内容 |
|---|---|
| `packages/deep-engine/src/webgpu/pbrShader.ts` | +`deepGiSpecularEnvironmentVisibility(environmentIrradiance, gi) -> f32`(合同注释 17 行 + 函数);`shade()` 镜面出射项乘 `specularEnvironmentVisibility`。共 +2 语义行,不改 C12 能量分配、不改 direct/emissive 项 |
| `packages/deep-engine/src/lighting/probeSpecularEnvironmentVisibility.ts` | 新增 TS 镜像(纯函数,逐式同步声明 + 合同文档) |
| `packages/deep-engine/src/lighting/probeSpecularEnvironmentVisibility.test.ts` | 新增变体语义回归测试 4 例 + WGSL 合同断言 |

未触碰:contracts 公共类型、Rust 链、storage 采样 WGSL(及其 sha256 钉)、并行在途文件的全部在途改动。

## 4. 测试证据(本机实测)

### 4.1 新增变体语义回归(4 例,`probeSpecularEnvironmentVisibility.test.ts`)

1. **正数例**:有效域内探针与环境同亮 → 1(白炉/开阔天空不变性);Rec.709 等亮度彩色记录放行;0.98 欠积分线性放行。
2. **负数例**:有效域内探针黑(封门室内,L4 实测 0-0.0005)→ 0(镜面 IBL 全抑制,intFloorBack 缺陷语义);负值通道 max(·,0) 截断不产生负可见度;半暗(0.25/0.5)线性压低。
3. **边界例**:域外(a=0/-1)恒 1;环境近黑(≤1e-4)恒 1;探针过冲 clamp 到 1。
4. **对照语义差异点**(GI-on 全量 vs GI-off 直显):sceneShader 含漫射 mix + 镜面 visibility 门控;
   C12 白炉能量分配子串保持;`shadeDirectNoEffects`/`shadeDirectOneCascade` 函数体**不含**
   `frame.eye.w`/`deepGiSampleTexture`/`specularEnvironmentVisibility`(直显纯直接光合同钉);
   门控函数单源定义一次、应用一次。

### 4.2 运行结果

- 聚焦族:`probeSpecularEnvironmentVisibility(4) + pbrShader(22) + probeClipmapSampling(13) + probeClipmapTextureSamplingWgsl(2)` = **37 passed / 4 skipped(naga 未配置时)**。
- **naga 校验**(`DEEP_SHADER_NAGA_BIN=~/.cargo/bin/naga.exe`):同族重跑 **26/26 绿**——
  合成 sceneShader 含新增函数通过 naga 解析+语义校验(此前 skip 的 naga 门全数执行)。
- deep-engine `tsc --noEmit` 净。
- 家族回归(lighting+rayTracing+threeBridge+webgpu,351 文件/2914 用例):**2883 passed**;
  4 个失败文件逐项定性,**均为并行在途域、无一由本刀引入**:
  1. `pbrEnvironmentIntensity.test.ts`:断言 `reflection, rough * maxSpecularLod)` ——该串被并行写者
     本轮 `pbrReflectionProbeWgsl.ts` LOD rebase 移除(L4 报告已登记同文件并行域失败);
  2. `pbrUnitNormalContract.test.ts`:并行写者新增锚点 `"  out.tangent = vec4f(1.0, 0.0, 0.0, v.material.z);\n"`
     假设分号行尾,而 HEAD 源码该行同行为 `...; out.dielectric = ...; ...`(锚点永不存在)——其 WIP 缺陷;
     锚点计数 HEAD=当前=1,本刀未触碰 vertexMain;
  3. `packetDeformationUnsupported.test.ts`:`stagePacketBuffers` 防御序变化(并行 packet 链在途);
  4. `hlodProxyDrawBatch.test.ts`:`rendererCapabilitySelfCheck` 报 `layeredMaterials` feature 漂移
     (并行写者加 feature 未同步 self-check 表)。

### 4.3 诚实边界

- **真机封门 leakRatio 复测未做**(GPU 测量沿账本单独排期,且多线并行期间不宜占机)。
  预期方向:镜面门控压低 sealedDelta 的镜面分量,intFloorBack 比值向 1 收敛;intBackWall/intPartition
  的 GI-on 像素同样受门控(其探针内容暗),openDelta 同步变化——比值口径下方向不定,须实测裁量。
- **室外像素非逐位零改动承诺**:门控在探针有效域内生效,开阔天空探针比值≈1 但非恒等 1;
  遮挡近旁(檐下/贴墙)按物理正确方向压低。室外 MAE 须真机复测裁量(沿底座遗留项)。
- 白炉几何域:炉内无探针体积(gi.a=0)→ 门控恒 1,白炉守恒链不受扰动(C12 合同子串测试钉住)。
- 禁 cargo 遵守:Rust 镜像未镜像本公式(该链待 cargo 线,沿 L3/L4 移交)。

## 5. 10 维自评(逐维 1-10,证据为本机实测)

| 维度 | 分 | 依据 |
|---|---|---|
| 现状核查 | 10 | 全仓 grep 含未跟踪;定义/消费点/钉面/并行在途逐一登记;任务名漂移如实澄清 |
| 语义裁定正确性 | 9 | 两族项集表 + 三分支保守边界 + 与漫射合同同边界论证;§4-b/c 处置明示 |
| 修复正确性 | 9 | naga 校验 + TS 镜像逐式 + C12/直显合同钉;最小 diff(+2 语义行) |
| 变体语义回归 | 10 | 4 例全绿(正/负/边界/对照),覆盖缺陷语义与不变性 |
| 回归控制 | 8 | 家族 2883 绿;4 失败逐项证据定性并行域(锚点计数/断言串/防御序/feature 表) |
| 证据链完整性 | 9 | diff 定位到行;naga/tsc/聚焦/家族四层输出在案 |
| 诚实边界 | 10 | 真机复测未做直说;室外非逐位承诺如实;任务名串扰不将错就错 |
| 同族排查 | 9 | shade() 全部消费入口(含直显 fragmentMainDisplay 复用核)逐一核对;钉面/生成链避碰 |
| 复现性 | 9 | 命令与预期输出全部在案;naga 门可复跑 |
| 工程纪律 | 10 | 禁 cargo/不改 contracts/不跑 wgsl:sync/不触并行在途/不 commit |

## 6. 移交与剩余

- [ ] 真机封门 leakRatio 复测(沿 harness,验证镜面门控的比值收敛)与室外 MAE 复测。
- [ ] thinwall 捕获主光缺席(L4 §4-c,捕获语义,producer 解析链)。
- [ ] Rust 镜像链(含本公式如需 CPU 对拍)待 cargo 线。
- [ ] 帧时 / GPU 复测 / Chebyshev 联测(沿账本原剩余项)。
- [ ] 并行在途域 4 失败文件的收口归并行写者(本刀仅登记证据)。
