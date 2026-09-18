# Deep Engine 多维度分析与五引擎对标（2026-09-15）

> **范围**：`packages/deep-engine`（Web/WebGPU，TS ~94k 行）、`packages/deep-engine-native`（Rust/wgpu ~56k 行），
> 以及两者在 `apps/web` 的产品接线。
>
> **对标基准**：Three.js、Babylon.js、Unity、UE5、Godot 4。
>
> **与既有文档的分工**：`docs/deep-engine-gap-analysis-2026-09-15.md` 是**静态代码盘点**，本文在其基础上做两件事——
> (1) 对关键结论做**源码级复核**；(2) 补上它明确未做的**性能实测**与**视觉效果实测**两个维度，
> 并首次把产品接线架构与项目级工程缺陷纳入。
>
> **诚实条款**：本文所有"缺失"结论均以源码目录搜索或脚本执行结果为准，不采信文档承诺。
> 竞品能力列为**基于既有知识的水位参照**，非本项目实测结果。取证边界见文末第七节。

---

## 一、结论先行

**Deep Engine 的渲染核水准不低，但它的定位不是"引擎"，而是"挂在 Three.js 场景图下的一个渲染后端"。**
这决定了它当前不可能在能力上对标 Unity/UE5/Godot，也不应按那个标准验收。

与此同时，项目整体存在比引擎差距更紧迫的问题：**主门禁当前是红的，工作区有 967 个文件未提交。**

三个维度的一句话结论：

| 维度 | 结论 |
|---|---|
| **能力** | 渲染核达到"能渲一帧"的水准（Forward+ 聚类灯光、TAA、Hi-Z、meshlet 都在），但**交互层（相机/拾取/剖切/选择/测量）在引擎内零实现**，高级效果层与物理/VFX 层整层缺失 |
| **性能** | 有实测，但夹具是玩具尺度且历史上长期被判无效。1024 实例时 Deep 略胜 Three WebGPU，10000 实例时打平。**没有任何 BIM 尺度的性能证据** |
| **视觉** | 后期栈只有 AO + Bloom + TAA/FXAA + ACES。TAA 是高质量实现（真材实料），但 SSR/景深/运动模糊/体积雾/体积光/大气散射/PCSS 全部为零 |

---

## 二、最重要的结构性发现

### 2.1 Deep Engine 是渲染后端，不是引擎

产品接线的真实做法（`apps/web/src/viewer/StudioDeepWebGpuBridge.ts`）：

- Three 的画布保留但透明度置 0，Deep 新建画布叠加其上
- `prepareAuthorInputCanvas` 让**输入事件仍然走 Three 的画布**
- 场景来源是 `projectionRoot()`，即 Three 的场景图

职责归属如下：

| 职责 | 归属 |
|---|---|
| 场景图 / 对象生命周期 | Three.js |
| 相机与导航 | Three.js（`apps/web/src/viewer/ViewerEngine.ts:62`） |
| 输入、拾取、测量、标注、IK | Three.js（`viewer/measurement.ts`、`viewer/ik.ts`、three-mesh-bvh） |
| 物理 | Rapier（`@dimforge/rapier3d-compat`） |
| **只有"画"这一步** | **Deep Engine** |

**推论**：把 Deep 拿去和 Unity/UE5/Godot 比"引擎能力"，比的是苹果和橘子。
公平的对标对象是**"渲染后端"这一层**——即与 Three 的 `WebGPURenderer`、Babylon 的 WebGPU 后端比。
产品级引擎能力（编辑器、场景管理、交互、物理）由 Three + Rapier + 自有编辑器承担。

### 2.2 产品里有两套互不相同的 "WebGPU"，需先消除歧义

| 路径 | 实现 | 状态 |
|---|---|---|
| `ViewerEngine.create(container, "webgpu")` | **Three 的 `WebGPURenderer`**（`three/webgpu`） | 产品实验后端 |
| Deep 旁路 | **Deep Engine 自有 `PbrRenderer`** | 独立旁路，经 Bridge 叠加 |

二者不是一回事，历史讨论中若混用会造成结论错位。

### 2.3 引擎内确实没有交互层（源码级复核）

| 检查项 | 命令/路径 | 结果 |
|---|---|---|
| 相机控制器 | `webgpu/` 目录仅 `cameraMath.ts`（lookAt 数学）、`cameraFrameHistory.ts`（抖动历史） |  无轨道/第一人称/漫游控制器 |
| 拾取 | `find -iname "*pick*" -o -iname "*raycast*" -o -iname "*bvh*"` | ❌ 零命中 |
| 剖切 | `*-clip*` / `*-section*` 命中项全部是 `probeClipmap`（GI 探针）等无关项 | ❌ Web 侧无裁剪平面 |

`docs/deep-engine-gap-analysis-2026-09-15.md` 的第一档结论经复核**准确**。

---

## 三、能力维度对标

以"渲染后端"为口径（此为公平比较基准）：

| 能力 | Three (WebGPU) | Babylon | Godot 4 | Unity URP/HDRP | UE5 | **Deep** |
|---|---|---|---|---|---|---|
| PBR metallic-roughness | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 完整（GGX/Smith/Schlick） |
| IBL / 预过滤环境 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ GGX mip + 辐照度 + DFG LUT |
| 级联阴影 CSM | 插件 | ✅ | ✅ | ✅ | ✅ | ✅ 2–4 级，4 档质量分级 |
| 软阴影 | PCF | PCSS | PCF/PCSS | PCSS | PCSS/RT | ️ **仅 3×3 PCF** |
| TAA | TSL 后处理 | ✅ | ✅ | ✅ | TSR | ✅ **高质量**（见 4.1） |
| AO | SSAO 插件 | SSAO2 | SSAO/SSIL | ✅ | ✅ | ✅ |
| Bloom | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **SSR** | 插件 | ✅ | ✅ | ✅ | ✅ | ❌ |
| **景深 / 运动模糊** | 插件 | ✅ | ✅ | ✅ | ✅ | ❌ |
| **体积雾 / 体积光** | 插件 | ✅ | ✅ | ✅ | ✅ | ❌ |
| **程序化天空 / 日夜循环** | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| GI | ❌ | 插件 | SDFGI/VoxelGI | APV | Lumen | ⚠️ 内核存在，未闭产品环 |
| **GPU 粒子** | 插件 | ✅ 系统级 | ✅ | VFX Graph | Niagara | ⚠️ 3 个孪生预设，无编辑器/无流场 |
| **物理** | Rapier 集成 | Havok 插件 | 内置 | PhysX | Chaos |  无 |
| **文字（3D / 动态）** | ✅ | ✅ | ✅ | TextMeshPro | ✅ | ❌ 无 SDF，依赖宿主预烘焙 |
| **大模型 LOD/剔除/流式** | BatchedMesh | ✅ | ✅ | ✅ | Nanite | ⚠️ **零件齐，未合流** |
| glTF 扩展覆盖 | 广 | 最广 | 广 | 广 | 广 | ⚠️ 仅 `emissive_strength` |

### 3.1 两个最关键的缺口

**缺口一：交互层（对产品是致命的）**

数字孪生平台的日常主干——"选、量、剖、标、走"——在 Deep 上一个都做不了。
这是"渲染核"与"引擎"的分界线，也是最痛的一档。

**缺口二：大模型能力"有零件无整车"**

GPU LOD 选择、meshlet、Hi-Z 遮挡剔除、indirect draw、octree、chunk 流式、驻留预算**全部有代码**，
但未接入正式场景。**瓶颈不在算法，在合流。**

### 3.2 一条硬约束，需单独点名

**native 侧显式拒绝绝对坐标 > 1e6 的场景，floating origin 未实现。**

这直接挡死了 BIM 大地坐标场景——而 BIM 场景天生就是大坐标。
这不是"待优化"，是"进不来"。

---

## 四、视觉质量维度

### 4.1 后期栈：覆盖窄，但 TAA 是亮点

**现有**：GTAO + Bloom + TAA + FXAA + ACES + vignette/色阶

**缺失**（源码零命中，非文档推断）：
SSR、景深、运动模糊、体积雾、体积光/神光、大气散射、程序化天空、PCSS/VSM、
区域光、镜头光晕、色差、胶片颗粒

对标山海鲸要求的"空气感"（雾 / 渐变背景 / 辉光），**当前只有解析式雾（线性 / exp2）+ Bloom**，氛围层明显不足。

**亮点是 TAA**。`postprocess/temporalAa.ts` 与 `temporalAaWgsl.ts` 实现了：

- 全分辨率 HDR 历史、双帧 ping-pong
- motion 向量重投影
- 基于深度的去遮挡拒绝
- **YCoCg 空间的邻域钳制**
- jitter 管理与失效判定（first-frame / resize / camera-cut / revision-gap）

这是教科书级的正确实现。引擎里这类"做得对"的地方不少——**问题是覆盖的面窄**。

**阴影侧**：`shadows/shadowQuality.ts` 有 4 档质量分级
（performance/balanced/high/ultra，对应 2–4 级联、1024–2048 贴图），并按设备 limits 自动降档。
**设计是好的**，但滤波只有 3×3 PCF，没有 PCSS/VSM，软阴影质量上不去。

### 4.2 实测画质差距

最新一次有效对比（10000 实例，`test-output/deep-engine/webgpu-1789323752892.json`）：

| 指标 | Deep | Three | 差异 |
|---|---:|---:|---|
| 平均亮度 | 0.2367 | 0.2439 | **Deep 暗约 3%** |
| 几何细节占比 | 0.1572 | 0.1683 | **Deep 细节少约 7%** |
| 视觉相似度 | 0.9413 | — | 门槛 0.92，**刚过线** |

12 项保真检查（profile / surface / hardware-samples / camera / geometry-instances /
material-inputs / textures / primary-light / environment / shadows / post-process / tone-mapping）
现在全部为 `equivalent`，这点修复到位。

但**相似度 0.94–0.95 意味着仍有约 5% 可感知差异**，且"暗 3%、细节少 7%"的方向性偏差值得排查
（需定位是色调映射、IBL 强度还是 AO 差异所致）。

### 4.3 夹具的画质代表性不足

基准截图实际内容是 **120 个无纹理基本体（方块/球/柱/锥/环）摆在平板上**。

该夹具能验证几何与提交成本，但**完全验证不了**：
纹理采样、材质复杂度、透明排序、细线闪烁、大场景深度精度。
用它做 BIM 画质验收等于没测。

---

## 五、性能维度

### 5.1 与 Three WebGPU 的对比

夹具：**1,840 三角面、960×540、DPR 1**——合成球体实例化场景。

| 实例数 | 指标 | Deep | Three WebGPU | 结论 |
|---|---:|---:|---:|---|
| 1024 | CPU P95 | 0.20 ms | 0.40 ms | Deep 胜 2× |
| 1024 | GPU P95 | 0.393 ms | 0.459 ms | Deep 胜 14% |
| 10000 | CPU P95 | 0.10 ms | 0.10 ms | 平手 |
| 10000 | GPU P95 | 3.67 ms | 3.67 ms | 平手 |

**判定**：1024 那次为 `candidate-meets-criteria`；10000 那次为 `candidate-does-not-meet-criteria`。

**历史值得注意**：2026-09-13 的连续 **6 次运行全部被判 `invalid` / `outcome=withheld`**，
原因是 `visual fidelity gate failed`——视觉相似度 0.9066，低于合同要求的 0.92 门槛。
即：最近修复之前，Deep 与 Three 的对比**曾被自己的证据合同判定为不可引用**。
现提升至 0.94–0.95 才转为 `comparable`。

### 5.2 证据强度的真实评级

**必须说清楚的限制：**

1. **GPU 时间戳分辨率约 65.5 µs**。`0.458752` / `0.393216` / `3.67` 这些值的差都是 65536 ns 的整数倍。
   在 0.1–0.5 ms 量级上做对比，**量化噪声与信号同阶**。1024 实例那 14% 的"GPU 优势"落在该精度下说服力有限。
2. **夹具仅 1,840 三角面、无纹理**，不能代表 BIM 场景，也无法暴露材质切换、draw call 瓶颈、显存压力等真实成本。
   仓库自身文档亦承认此点（`docs/deep-engine-gap-analysis-2026-09-15.md:12` 指出 `gpu=27ms` 是主机耗时而非 GPU 时间戳）。

> **结论：目前不存在任何可支撑"Deep 性能优于 Three"的 BIM 尺度证据。**
> 有的只是"在极简合成场景下不落下风"。

### 5.3 反向发现：Three 自己的 WebGPU 后端有严重退化

`test-output/render-engine-comparison/report.md` 是本项目最严谨的一份实测
（每组 5 次冷上下文、固定 1440×900、真实 RTX 4060）。它对比 Three 的 WebGL vs WebGPU：

| 负载 | 指标 | WebGL | WebGPU |
|---|---:|---:|---:|
| static/120 | P99 中位 | **7.4 ms** | **61.9 ms** |
| static/1000 | P99 中位 | **13.9 ms** | **93.6 ms** |
| static/1000 | 20 次重建堆增 | 0.1 MiB | **119.6 MiB** |
| 任意 | 初始化 | 26–35 ms | 138–176 ms |
| 任意 | 首帧 | 49–64 ms | 187–259 ms |

**Three 的 WebGPU 在本项目中 P99 比 WebGL 差约 8 倍，且有约 120 MB 堆泄漏。**

这解释了报告结论为何是 `promotionDecision=blocked-incomplete-release-coverage`，生产默认仍为 WebGL。

**对 Deep 而言这是机会信号**：若 Deep 能在真实 BIM 场景下稳住尾帧，
它相对 Three WebGPU 存在明确的差异化空间——当前的 Three WebGPU 在本项目里并不好用。

---

## 六、项目整体缺陷

以下均为**实际执行验证**所得，非推测。

### 6.1 主门禁当前是红的 ⚠️

执行 `node scripts/check-source-size.mjs` 的输出：

```text
[source-size] 源文件体量门禁失败：
- apps/web/src/App.tsx: 810 行；新文件或已拆分文件不得超过 800 行
- apps/web/src/hooks/useAppRuntimeEffects.ts: 832 行；新文件或已拆分文件不得超过 800 行
```

该门禁是 `pnpm typecheck` 与 `gate:deep-p0` 的一环（见根 `package.json`），
**800 行硬上限、无豁免**。这意味着主门禁链路目前跑不通。

### 6.2 967 个文件未提交

工作区有 **967 项变更未提交**，最后一次提交仅为
`cd9850b feat: checkpoint Deep Engine and platform upgrades`。
"checkpoint" 已严重滞后，这是并行多会话协作下丢失工作的真实风险。

### 6.3 Unity 对照基准跑不起来

`benchmark-build.log` 结尾是 Unity Editor 崩溃栈：

```text
0x00007FF77AB996B7 (Unity) HandleProjectAlreadyOpenInAnotherInstance
```

而 Unity Release Player 对照是 `verify:gpu-release` 与性能晋级门槛的必要环。
**当前与 Unity 的任何性能结论都无从产生。**

### 6.4 测试覆盖严重不均

按实现文件 / 测试文件比：

| 包 | 比例 | 说明 |
|---|---:|---|
| `jt-reader` | 13 : 1 | ️ 工业 CAD 格式解码器，正确性关键却几乎无测试 |
| `ppr-lite-engine` | 10 : 2 | 偏薄 |
| `industrial-agent-orchestrator` | 8 : 2 | 偏薄 |
| `deep-engine` | 550 : 295 | 尚可，但 GPU 路径多为 mock |

**JT 格式解码器的测试缺失值得单独点名**：格式解析器的缺陷直接产出错误几何，且难以在运行时发现。

### 6.5 原生侧自述未完成清单很长

`packages/deep-engine-native/README.md:61` 坦诚列出：
GPU compute 曲面细分、孔洞/多子路径、闭合描边、原生字体 shaping、中文 IME、
压缩纹理、自动 mip、多级 Bloom 金字塔、OIT、glTF/纹理解码与流式、
安装器、签名、自动更新。

**原生端目前是"能显示首帧"的状态，不是可交付客户端。**

---

## 七、改进优先级建议

按"投入产出比 × 对可用性的伤害"排序。

### P0 — 先止血（与引擎无关，但更紧急）

1. **修掉源文件门禁**：拆 `useAppRuntimeEffects.ts`（832 行）与 `App.tsx`（810 行）。
   这是主门禁红的唯一原因，成本极低。
2. **提交那 967 个文件**，或至少按主题分批提交。checkpoint 滞后本身就是最大风险源。
3. **解决 Unity Editor 进程冲突**，让对照基准能跑——否则性能晋级永远缺一环。

### P1 — 让性能证据站得住（否则后续全是空谈）

4. **建立 BIM 尺度夹具**：现有 1,840 三角面夹具证明不了任何事。
   至少需要 100 万–1000 万三角面、数百材质、真实纹理的场景，否则"性能"维度无法验收。
5. **提高 GPU 计时精度**：当前 65.5 µs 量化在毫秒级对比中噪声过大。
   需多次采样取统计量，或接受"只能测 ms 级差异"的限制并如实声明。

### P2 — 把已有零件装成整车（杠杆最大）

6. **合流 LOD / Hi-Z / meshlet / 流式**到正式场景。
   这些代码已经存在，是"从组件证据到产品能力"的关键一步，也是唯一能真正承载 BIM 级场景的路径。
7. **实现 floating origin**：不做这个，大坐标 BIM 场景连门都进不来。

### P3 — 交互层最小集（决定能否演示）

8. 轨道相机 + 拾取（可复用产品侧已有的 three-mesh-bvh 经验）+ 选择高亮 + Web 剖切平面。
   **量级不大，但缺了就什么都演示不了。**

### P4 — 氛围层补齐（性价比最高的画质提升）

9. 体积雾 / 程序化天空 / 日夜循环——纯 shader 层工作，
   与现有 Bloom/ACES 栈衔接顺畅，对标山海鲸"空气感"见效最快。
10. **顺势项**：SSR 与运动模糊（TAA 的 motion 向量已在手，运动模糊只差一步）、阴影升级 PCSS。

### 不建议现在做

物理引擎、通用粒子编辑器——数字孪生场景当前依赖度低，产品侧已有 Rapier 覆盖，可延后。

---

## 八、取证边界声明

为免误导，明确区分结论强度：

**✅ 实际验证的**

- 源码目录搜索（交互层缺失、后期栈覆盖、TAA/阴影实现代码、产品接线架构）
- 门禁脚本执行结果（`check-source-size.mjs` 输出）
- 基准 JSON 原始数据与判定字段（`webgpu-*.json`、`report.json`）
- 基准截图实读
- 测试覆盖率统计、git 工作区状态、Unity 崩溃日志

**⚠️ 采信但未独立验证的**

- 既有 `docs/deep-engine-gap-analysis-2026-09-15.md` 中关于 native 侧与部分能力项的结论
  （已做抽样交叉验证，未逐条复核）

**❌ 未做的**

- 未运行引擎、未自行执行浏览器渲染对比、未独立测量 GPU 性能
- 未验证竞品侧的实际数字。**第三节竞品能力列是基于既有知识的水位参照，不是本项目实测结果**——
  用于确定目标，不能当作验收证据

---

## 九、总体判断

这份代码库的**工程纪律明显高于行业平均**：冻结的 shader ABI、golden 像素对照、
证据合同会主动判自己 `invalid` / `withheld`、跨语言 golden 测试。

`candidate-does-not-meet-criteria` 这种"自己承认没达标"的输出，比任何"全绿"报告都更可信。

**真正的问题不是能力，是重心**——
把大量精力投在了渲染核的深度上，而**交互层**与**合流**这两件"让能力可用"的事被延后了。

---

## 附：相关文档

| 文档 | 侧重 |
|---|---|
| `docs/deep-engine-gap-analysis-2026-09-15.md` | 静态代码盘点（本文复核了其关键结论） |
| `docs/rendering-performance-benchmark.md` | 基准方法论与判定门槛 |
| `docs/render-engine-selection-2026-08-30.md` | 引擎选型决策 |
| `docs/platform-gap-analysis-2026-09-09.md` | 产品平台层结论（与本文互补） |
| `test-output/render-engine-comparison/report.md` | Three WebGL/WebGPU 实测原始报告 |