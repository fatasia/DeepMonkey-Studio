# 三端无感发布:Runtime Package 落地设计与缺口

> **已被取代(2026-09-15)**:本文已合并进 [三端无感发布实现交接](三端无感发布实现交接-2026-09-15.md);实现以合并版为准,本文保留为分析过程记录。

日期:2026-09-15
前文:[原生发布架构分析](原生发布架构分析-2026-09-15.md)(路线与竞品参考;本文承接其"阶段 0")
基线:实际读码所得,逐项标注路径;不新增任务编号,只对既有任务表(D01–D28)的接缝给建议

---

## 0. 结论

"三端无感"的公式**已经完整存在于代码里**,缺的是两处接线:

```
                     ┌─→ Web/WebView: TS runtime 执行   ← 缺 loader(G2)
同一份 DeepRuntimePackage ─┤
                     └─→ Native:      Rust runtime 执行 ← 已具备(装载/LKG/GPU 前置核对)
                            ↑
                     缺:发布侧不产包,只产"素材 ZIP + conversionRequired 标记"(G1)
```

原生侧已能装载并执行 Runtime Package;真正的跨距在**发布侧不产真包、web 侧不读包**。
把这两个跨距接上,"无感"即成立;其余都落在既有任务表的范围内。

---

## 1. 事实基线(实测)

### 1.1 包格式已定型(TS 侧)

`packages/deep-engine/src/runtimePackage/`

- **内容真相**(`types.ts`):`DeepRuntimePackageV1/V2` = `renderPacket` + `deep2d-runtime` + `ibl-environment` + `shader-package` 四类资源 + `materialBindings`(v2 显式化可执行材质归属)。
- **校验 fail-closed**(`validation.ts`):资源索引必须按 id 排序唯一;`payloads` 键与索引**精确一致**;每个资源内容 SHA-256 必须匹配;entrypoint 角色唯一且覆盖全部资源;shader 必须过 v2 合同;materialBindings 必须与 packet 材质一致。
- **预算**(`types.ts`):`inputBytes 256MB / nodes 2M / depth 32 / resources 132 / shaderPackages 128`;deep2d atlas 驻留 64MB(`deep2d.ts`)。
- **预热计划**(`prewarmTypes.ts`):资源 + shader-pipeline 两类 item、缓存键去重、估算字节预算、并发 ≤16、**原子 commit**、并携带 `RuntimePackageBakeEvidence`(几何 plan / meshlet / LOD residency)。
- **纯净化审计**(`packagePurity.ts`):禁止 unity / webgl / webview / chromium / electron / cef / browser-runtime / **wasm** / **js/html/css** 痕迹。
  → 推论:**发布包内不携带任何代码**,只携带数据;"无感"只能靠"数据 + 两端各自 runtime 解释"实现。这同时封死了"往包里塞 web 运行时/WASM 兜底"的所有后路,GPT 式方案在本仓的门禁下根本进不来。

### 1.2 原生侧已能执行包

`packages/deep-engine-native/src/`

- `runtime_package_startup.rs`:`load` / `load_auto`(文件或字节)→ 校验 → `prepare`;`PlayerContent::from_package` 在**创建窗口之前**做执行支持核对(`plan_shader_materials` + `prepare_runtime_content`),不通过即拒绝。
- LKG:primary 被拒 → 恢复 last-known-good,输出结构化诊断 JSON;present 成功后**才** commit 检查点。
- 入口:拖放 Runtime Package JSON、CLI `--packet`、`recover`。
- 已有 native 测试基线:`deep2d_runtime_atlas`、`deep2d_text_contract`、`chart_ir_contract`、`chart_render`、`chart_scales`、`control_render_contract`。

### 1.3 发布侧(缺口所在)

`apps/web/src/delivery/sceneClientPackage.ts`

- 产物 = `.bimscene.zip`:`scene.json` / `applications.json` / `project.json` / `runtime.json` / `assets/` + `manifest.json`。
- manifest 的 `nativeRuntime` 只有一句声明:
  ```ts
  { kind: "deep-engine.runtime-package", schemaVersion: 1, conversionRequired: true }
  ```
  **包内没有任何 `renderPacket` / `deep2d` / `ibl` / `shaderPackage` 载荷** → native 拿到的是"素材 + 场景 JSON",还需要一次转换(D07/D08)。
- `capabilities` 是四个布尔(`twoD/threeD/dataBindings/liveConnections`),不是对象级 `supported/degraded/blocked/webview-only`。
- 资源闭包靠字符串搜索(`serialized.includes(asset.url)`),`modelIds` 为空时打包**所有**模型(任务表已列为待办 D06)。
- 资产有逐文件 sha256,但 `scene.json`/`applications.json` 无 hash,也没有包级内容 hash 与版本语义(D04 待办)。

### 1.4 Web 侧(缺口所在)

- 在线发布 = API JSON 快照 + 只读路由(`PublishedApplicationRoot` / `SceneViewerRoot` 消费 applications/scene JSON)。
- `deep-engine`(TS)有完整**执行能力**(RenderPacket、deep2d display list、shaderPackage),但**没有"DeepRuntimePackage → 运行时"的加载/执行入口**。
- 结果:即使发布侧做出了真包,也只有 native 能消费 → 三端无感缺一条腿。

---

## 2. 缺口清单

| # | 缺口 | 证据 | 影响 | 归属 |
|---|---|---|---|---|
| G1 | 发布侧不产真包(只产素材 ZIP + `conversionRequired`) | `sceneClientPackage.ts:103-105` | native 拿到的不是可执行包;转换成为额外交付工序 | D04 / D07 / D08 |
| G2 | web 侧无 Runtime Package loader | 无对应代码(执行层齐、入口缺) | 同一包无法在 web/webview 执行 → 三端不同源 | 新增建议 |
| G3 | 2D 无共同数据源:`DashboardDocument v1` 未冻结 | 4A 决策已定方向;任务表 D15 前置 | 2D 完全不能无感(编辑器 React 树 ↔ native 无输入) | D15 前置 |
| G4 | 能力预检非对象级、非分目标 | `manifest.capabilities` 四个布尔 | 用户看不到"哪一端降级了什么" | D02 / D03 |
| G5 | Browser↔Native 像素对照缺 | support matrix §4(D09);任务 D26 | 一致性无证据,回归不可测 | D26 提前 |
| G6 | 文本/字体烘焙链未建 | D05;deep2d text 依赖 host 预烘焙 glyph;包内 atlas 为 base64 | 中文/富文本发布即降级 | D05 + 发布期烘焙 |
| G7 | 容器 manifest 与包内语义未统一(版本 / feature flags / 后端要求) | 任务表 D04 已列 | 目标混淆、校验语义不一致 | D04 |

未核实(需执行时确认):native 的 `player_shader_plan` 与 TS 的 `prewarmPlan` 是否已语义对齐(是否共享同一预热顺序与去重键);`PlayerContent` 是否消费 bake evidence。

---

## 3. 定型建议(接口草案)

### 3.1 容器 = 一个 ZIP,内含真包

```
scene.bimscene.zip
├─ manifest.json            容器清单 v2(见 3.2)
├─ runtime/package.json     DeepRuntimePackageV2(内容唯一真相,现有 builder 产出)
├─ assets/...               原始资产(供重烘焙与审计)
└─ README.txt
```

- `runtime/package.json` 由**发布侧**用现有 `buildDeepRuntimePackage` 生成(输入:转换器 D07/D08 的产物 + IBL + shaders + materialBindings)。
- 分工:**容器承载交付语义**(目标、来源、能力、原始资产),**包承载运行语义**(资源、哈希、入口)。purity 审计只作用于包本身。

### 3.2 manifest v2 草案(容器清单)

```jsonc
{
  "kind": "bim-studio-scene-client-package",
  "schemaVersion": 2,
  "target": "web" | "three-webview" | "deep-native",
  "package": { "path": "runtime/package.json", "packageId": "…", "packageVersion": "…", "packageHash": "…" },
  "provenance": { "projectId": "…", "sceneId": "…", "publishedAt": "…", "generatedAt": "…", "builder": "…" },
  "capabilityReport": { /* 见 3.4 */ },
  "files": [ { "path": "…", "bytes": 0, "sha256": "…" } ]
}
```

- 关键新增 `target: "web"`:同一容器同时服务 web(静态托管/本地打开)与 native(下载打开);`deep-native` 目标不再带 `conversionRequired`(转换已在发布侧完成)。

### 3.3 Web loader 最小接口(与 native 流程语义对齐)

```ts
interface RuntimePackageHost {
  load(source: string | ArrayBuffer, signal?: AbortSignal): Promise<DeepRuntimePackage>;
  // 与 native PlayerContent::from_package 相同的顺序:
  // 校验 → 执行支持核对 → prewarm plan → 原子 commit → 首帧
  open(pkg: DeepRuntimePackage): Promise<{
    prewarm: RuntimePackagePrewarmPlan;
    commit(signal?: AbortSignal): Promise<RuntimePackagePrewarmResult>;
  }>;
}
```

- 顺序必须与 native 一致:`validateDeepRuntimePackage` → 资源预热(`buildRuntimePackagePrewarmPlan` + `RuntimePackagePrewarmExecutor`,原子提交,失败保留旧状态)。
- 渲染侧直接复用既有执行层:RenderPacket → deep-engine WebGPU;deep2d → display list(TS)。
- 这一步完成即是"同一包三端跑"的证明件,**成本低(全部复用现有实现,只补入口)**。

### 3.4 能力预检输出(对象级、分目标)

```jsonc
"capabilityReport": {
  "targets": ["web", "native"],
  "objects": [
    { "id": "chart-17", "capability": "chart",
      "web": "supported", "native": "degraded",
      "reason": "…", "fallback": "静态矢量图" }
  ],
  "summary": { "web": { "supported": 0, "degraded": 0, "blocked": 0 },
               "native": { "supported": 0, "degraded": 0, "blocked": 0 },
               "webviewOnly": 0 }
}
```

- 规则沿用既有决策:未知能力默认 `blocked`(D02);C 档 `webview-only` 在 `deep-native` 目标下必须阻断或明确要求 Three WebView(4A)。
- 预检结果写入容器 manifest,web 与 native 打开时都可回显"哪些对象降级了、为什么"。

### 3.5 2D 的无感源:`DashboardDocument v1` 成为编辑器保存产物

- 编辑器**保存时即产出** `DashboardDocument v1`(A 档子集:节点树 + 样式 token + 数据绑定 + 命中区域),而不是"导出时转换"。
- web 端渲染源 = 同一份 DashboardDocument。**建议 web 端优先用 deep2d(TS)渲染以与 native 同源**;DOM/React 渲染保留给编辑器本体与 C 档页面 —— 这是"无感"与"web 生态"的取舍点,需要拍板(见 §6)。
- native 渲染源 = 同文档 → Deep2D retained commands(A 档);超集走 B(适配器)/C(webview-only),并在预检中可见。

---

## 4. 三个关键路径与顺序建议(不改任务编号)

1. **D07/D08 的产物直接定义为 `DeepRuntimePackage`**,不是中间格式:转换器在 web(发布)侧运行,输出即包;native 只装载不转换。这样 D10"导出产物接正式 Native 启动"自然成立,且同一产物可直接喂给 web loader(G1/G2 同时收敛)。
2. **`DashboardDocument v1` 冻结提前到 M1 之前**(原为 D15 前置):它是 2D 无感的分水岭;越晚冻结,编辑器与 native 的 2D 分叉越深、返工越大。
3. **web loader 与 Browser↔Native 像素对照靠近 M1 结束**(D10 之后):loader 是"三端无感"的证明件(成本低);像素对照(D26 的跨端部分)提前,避免差异在 M2 之后一次性爆发。

---

## 5. 验收定义(可测试的"无感")

- **同源**:同一容器,web 打开、webview 打开、native 打开 —— 布局、文字、图表数值、DPI 一致;唯一允许的差异是 `capabilityReport` 中登记的对象级 degraded/blocked。
- **编辑器所见 = 发布后所见**(除登记降级)。
- **回归**:任一端 golden 失败即阻断发布;容器/包 hash 变更可追溯;篡改单字节必须被拒绝。
- **证据**:同 fixture 三端截图对照(D26)+ 对象级能力报告 + 三端 prewarm/首帧日志(同一 packageHash)。

---

## 6. 需要拍板的两点

1. **web 端 2D 渲染源**:deep2d(与 native 同源,放弃部分 DOM 生态)vs DOM/React(生态最大化,web 与 native 有布局/文字差异)。
   推荐:发布产物走 deep2d;编辑器与 C 档页面保留 DOM。理由:无感的定义就是同源,且 `echartsOptionCompat`/`chartIr` 已为此铺路。
2. **`target: "web"` 的定位**:是把"web 打开同一容器"作为正式交付目标(需要 loader + 静态托管),还是仅作 webview/Three 目标的既有形态。若选前者,G2 立刻从"建议"升为 M1/M2 的正式任务。

---

## 7. 与既有文档的关系

- [原生发布架构分析](原生发布架构分析-2026-09-15.md):路线选型与竞品参考;本文承接其"阶段 0"并给出落地接口。
- [零旧包袱原生客户端架构](deep-engine-native-gui-migration-2026-09-12.md):不动其边界(零 WebView、全 WebGPU GUI);本文只补"发布侧产包 + web 侧读包"两处接线。
- [后续开发任务清单](deep-engine-next-development-tasks-2026-09-15.md):不新增任务编号;§4 的三条顺序建议供领取时参考。
- [Deep2D 支持矩阵](deep2d-support-matrix-2026-09-14.md):一致性裁决依据;§5 的验收沿用其"支持/拒绝/校验拒绝"三态。