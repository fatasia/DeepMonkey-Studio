# Deep Shader 编辑器能力验证记录（2026-09-12）

## 1. 本批结论

本批把 Shader 创作从设计文档推进到隔离的可运行编辑器能力：作者可在 Deep Engine Lab 中编写受预算的 DeepSL surface v1，经过语法检查、typed Shader IR、WGSL 生成和当前 WebGPU 设备编译后，才提升为可预览版本；无纹理、非双面 Standard 子集还能进入固定 ABI adapter，并由 Browser/Native executor 实际执行。失败候选不会覆盖最后一次正确产物。

这项能力位于 `packages/deep-engine` 与独立 Lab，没有接入或修改正式 `apps/web` 的引擎入口。它验证了现有 Studio 可以接入的共享创作内核；正式节点图、磁盘 CAS/热重载、通用材质布局适配和 Studio UI 接入仍需后续批次完成。本轮不另建原生编辑器。

## 2. 设计读取与产品取舍

- 创作模型参考 Unity Shader Graph / ShaderLab 的 Surface、Pass、变体和诊断分层，但不把它们的运行时、格式或 UI 依赖带入 Deep Runtime。
- 常用路径保持 Three.js 式低样板：Standard/Unlit 模板和少量语义属性即可生成可编译结果；Technique、Pass、Graph、DeepSL 与生成 WGSL 按能力逐层展开。
- Lab 采用现有 `apps/web/src/styles/base.css` 设计令牌，界面以源码、状态、诊断、生成结果为主，不增加装饰性卡片或硬编码品牌色。
- 编辑器保存的是稳定的创作资产；发布产物只携带实际使用的 WGSL、反射、Pass、变体和 ABI，不携带 React、Three、Graph UI 或编译器。

参考基准：

- [Unity Shader Graph](https://docs.unity3d.com/cn/6000.0/Manual/com.unity.shadergraph.html)
- [Unity ShaderLab Pass](https://docs.unity3d.com/cn/current/Manual/SL-SubShader-pass.html)
- [Three.js Shading Language](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language)
- [Three.js ShaderMaterial](https://threejs.org/docs/pages/ShaderMaterial.html)

## 3. 已实现的编辑与编译闭环

1. `shader-authoring` 提供 Graph/DeepSL 文档、确定性 revision、有界 undo/redo、候选编译事务、异步 stale 丢弃和 last-known-good。
2. 内置 DeepSL surface v1 支持 Standard/Unlit、baseColor、metallic、roughness、alpha、double-sided 与 baseColor texture，提供严格未知/重复语句错误、行列诊断、输入预算和 WGSL→DeepSL source map。
3. Lab 的“编译并校验”依次执行 DeepSL 解析、typed IR 验证、WGSL 生成、`GPUDevice.createShaderModule` 和 `getCompilationInfo`；只有全部成功才更新生成结果。
4. 输入变化会让旧的异步结果失效；超过输入预算的草稿不会误编译会话中的旧源码；编译失败时明确显示“继续使用上次正确版本”。
5. typed Shader IR 已实现 Standard PBR Surface Output 与 Lighting Context v1。生成的 WGSL 执行 GGX/Smith/Schlick、直接光、PCF 阴影、diffuse/specular IBL、AO、emission、alpha 与线性 HDR 输出；当前只冻结一个方向光和校准辐射强度，不把它描述成任意灯光系统。
6. `deep-shader-package` v2 已冻结完整 pipeline 描述，Browser `ShaderPackageExecutor` 在真实 GPU 上创建 forward/shadow ShaderModule、BindGroupLayout、PipelineLayout 与 RenderPipeline；候选全部成功后才原子提交 cache。

当前 DeepSL 示例：

```deepsl
shader deep.material {
  surface standard;
  baseColor [0.12, 0.42, 0.9, 1];
  metallic 0.65;
  roughness 0.24;
  alpha opaque;
  doubleSided false;
  baseColorTexture off;
}
```

## 4. 浏览器视觉与交互证据

在本机独立 Lab 和真实 NVIDIA WebGPU 设备上完成两轮以上视觉复核：

- 深色主题：源码区、生成 WGSL、状态、错误与警告层级清晰，设备首帧与 DeepSL 编译均通过。
- 浅色主题：强调按钮使用 `--accent` / `--on-accent`，文字对比度与诊断状态可读。
- 480 px 窄宽：Shader 双栏自动堆叠，源码区 `clientWidth` 与 `scrollWidth` 相等，页面没有横向溢出。
- 长页面可以使用普通滚轮到达 Shader Studio；修复了宿主 `body { overflow: hidden }` 继承导致的不可滚动问题。
- 将 `metallic 0.65` 改为 `metallic 2` 后，界面显示精确 `3:3` 错误并保留上一版 WGSL；恢复样例后可再次成功编译。
- textarea 通过 `aria-describedby` 关联诊断，诊断列表与状态使用 live region；浏览器控制台最终轮为 0 error / 0 warning。

## 5. 设计十维自评

| 维度 | 分数 | 证据 |
|---|---:|---|
| 布局层级 | 9.1 | 创作区、操作、诊断、生成结果四层清晰；窄宽自动单列 |
| 设计令牌 | 9.5 | 颜色、边框、圆角与状态全部复用正式设计令牌 |
| 字体与数值 | 9.1 | 编辑区采用等宽字体，状态与说明保持现有中文层级 |
| 状态完整性 | 9.3 | dirty、compiling、ready、warning、error、LKG 均有真实行为 |
| 动效纪律 | 9.0 | 不添加无意义动效；继承 reduced-motion，持续渲染可关闭 |
| 3D/渲染一致性 | 9.2 | Standard 真实生成 PBR WGSL；编辑器与 WebGPU Lab 共用设备和验证记录 |
| 信息密度 | 9.1 | 默认只展示源码、诊断、输出和三个必要操作 |
| 交互反馈 | 9.4 | 当前候选、过期候选、设备失败与上次正确版本区分明确 |
| 响应式与主题 | 9.2 | 深/浅主题与 480 px 均经浏览器实际复核 |
| 语义与文案 | 9.2 | 明确区分 Frame ABI 复用、布局适配缺口和完整跨端执行能力 |

## 6. 工程验证

- `pnpm --filter @bim-studio/deep-engine typecheck`：通过。
- `pnpm --filter @bim-studio/deep-engine test`：Vitest 55 文件 / 627 项通过；Node 合同与扫描器 26 项通过；131 个 Browser/core 源文件、60 个 Native 源文件和 194 个 Windows resolved packages 的 runtime purity gate 通过。
- `build`、`lab:build`、Shader inventory 与隔离门禁通过；12 个公开 ESM 构建入口均可导入。
- Lab 构建 SHA-256：`1efdfffd589d28df3c3507dbe1ce5de99701fc843601a2ec644a74ea6f1b3b51`；JavaScript 296,484 B，gzip 88,377 B，运行时引擎依赖为空。
- 本机 NVIDIA Lovelace WebGPU 最终保存记录：`test-output/deep-engine/webgpu-1789225253397.json`。v2 package 的 forward pass 为 4×MSAA、required resolve、depth24plus；shadow pass 为 1×、depth32float；DeepSL PBR 三材质读回有限且粗糙度亮度差 `1.301133`。同一记录的 GPU culling 实机 readback 为输入 4、压缩后可见 2、间接 `indexCount=3`；PbrRenderer 的不透明与阴影批次已实际走 compute→compaction→drawIndexedIndirect，透明批次保留排序直绘，浏览器控制台 0 error / 0 warning。
- 失败样本 `metallic 2` 在前一轮记录 `test-output/deep-engine/webgpu-1789218573175.json` 中产生 `3:3 unknown-statement`，并确认 `retainedLastKnownGood: true`；恢复样例后再次编译成功。
- Native 根复验为 Rust 91/91、fmt、clippy 和 textured/alpha/textured+Deep2D/shadow/IBL Vulkan release smoke 全通过；IBL HDR 读回 `changed_pixels=915`，on luminance `255.374535` > off `184.904717`。release EXE 7,895,552 B，SHA-256 `0D69FF58746DCC7066099D65E49AA3F8A7A17977729C6FCB31BBA1E0A94D94A3`。

这些证据证明 Browser 创作内核、PBR lowering、固定 adapter、Native package pipeline 与 IBL/culling 基础链路成立，不等于完整 Unity Shader 能力或正式编辑器已完成。

## 7. 已知边界与下一步

- Lab 当前使用原生 textarea，尚未提供 Monaco 级补全、跳转、重构或原生文本组件。
- DeepSL surface v1 只提交单个 forward 候选；Technique/多 Pass 文本语法尚未开放，Standard 的 depth/shadow/object-id 辅助 Pass 仍失败关闭。
- Standard 已接入 PBR lowering，但当前 Lighting Context 只有一个方向光；clustered lights、探针选择、可配置辐射强度和高级材质模型仍未实现。
- Graph 已有类型化资产与会话内核，尚未实现可视节点画布、subgraph 与 inspector 联动。
- v2 Shader Package 与 Browser/Native executor 已完成；Native 已从同一 package 创建真实 forward/shadow GPU pipeline 并通过 RGBA16F/depth readback。
- DeepSL Standard 的无纹理、非双面固定子集已由 layout/entry adapter 转成 `deep.pbr.mesh.v1` pass，并在 Browser/Native 实机执行；纹理、MASK、双面与通用多材质仍需扩展。
