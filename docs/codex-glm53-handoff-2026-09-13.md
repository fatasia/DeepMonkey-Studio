# Deep Engine → GLM 5.3 Flash 交接（2026-09-13 23:00）

状态：Codex 本轮收尾；源码、样本、验证报告均留在当前工作树，未提交、未 push。

## 1. 接手目标与硬边界

当前任务是继续实现自研 Deep Engine，不是重写现有 Studio。目标运行面只包含：

- Browser WebGPU 开发与验证客户端。
- Windows 原生 Rust `winit + wgpu` Viewer/Client。

当前明确排除 macOS、Linux、Android、iOS：不开发、不构建、不测试、不进入完成度分母。Unity 包、Unity WebGL/WebGPU 构建兼容也暂缓。现有 React/Three Studio 是已经存在的作者编辑器，不新建原生编辑器。

必须长期保持：

- 正式 `apps/web` 默认 Three 路径、现有项目、数据库、MinIO、账号 `admin/admin` 和脚本行为不受实验引擎影响。
- Deep 核心只用 WebGPU/wgpu；原生制品不得包含 WebGL、WebView、Chromium、Electron、React、ECharts、Three 或 Babylon 运行时。
- Three 只允许位于隔离兼容桥和基准 Lab，不能渗入 Deep core/native。
- 单文件原则上不超过 300 行；800 行绝对阻断。错误、取消、超时、设备丢失、资源回滚必须失败关闭。
- 真实能力必须有真实资产、真实 GPU 或跨实现 golden 证据。固定球体、mock 和类名计数不能替代完成证据。
- 不得降低画质门槛、性能门槛或测试断言来制造“超过 Three/Babylon”结论。

## 2. 必读顺序

接手后先读，不要根据聊天片段重建计划：

1. `AGENTS.md`
2. `docs/active-task-recovery-ledger.md`
3. `docs/specs/deep-engine-execution-plan-2026-09-12.md`
4. `docs/specs/deep-engine-delivery-backlog-2026-09-12.md`
5. `docs/specs/deep-engine-webgpu-verification-2026-09-12.md`
6. `docs/specs/deep-engine-competitive-benchmark-contract-2026-09-12.md`
7. `docs/specs/deep-engine-shader-system-2026-09-12.md`
8. `docs/specs/deep-engine-three-plugin-compatibility-2026-09-12.md`
9. `docs/specs/deep-engine-native-gui-migration-2026-09-12.md`
10. 本文。

再执行 `git log -5 --oneline`、`git status --short`。当前工作树包含多个会话的大量未提交改动；只修改自己核验过的文件，禁止 reset、checkout、clean、stash 或删除他人的改动。

## 3. 当前优先级

| 优先级 | 范围 | 执行原则 |
|---|---|---|
| P0 | `WEB-01..08`：RenderPacket、真实模型/纹理、基础和高级材质、动画集成、光照、后处理、性能、Browser 交付 | 当前主阻塞链，优先闭环 |
| P1 | `WEB-09..11/13`：Nanite Lite、Deep Lights、GI Lite、轻量烘焙 | 复用 P0 基础；不得抢占 P0 根因修复 |
| P2 | 轻量 Shader、高频 Three 兼容、`SWITCH-01..06`、`NATIVE-01..08`、核心资产包、`PACK-01..06` | 战略必做，依赖满足即推进；不是可删除的低优先级 |

代码质量、runtime purity、单文件体量、真实样本、真实 GPU、公平基准、正式环境隔离是全程门禁。

## 4. 本轮新增和修复

### 4.1 缺失法线

- 新增 `packages/deep-engine/src/gltf/generatedNormals.ts`。
- 以索引三角形生成面积加权平滑法线，尊重绕序；退化三角形或没有有效贡献的顶点明确拒绝。
- `meshResources.ts` 现在只强制 POSITION；缺失 NORMAL 时生成 owned `Float32Array`。
- 新增 `generatedNormals.test.ts`，并更新 glTF 解码合同。

### 4.2 真实导出器四元数舍入

- `nodeTransforms.ts` 接受长度误差不超过 `1e-3` 的有限四元数并归一化。
- 近零四元数和更大偏差继续拒绝。
- 原因是 Khronos 真实样本包含 `[0,0,0.707,0.707]`，其长度约 `0.999849`；旧 `1e-5` 阈值误拒绝合法导出结果。

### 4.3 authored TANGENT 进入核心几何合同

- `AccessorReader` 新增 `tangent` 读取种类，仅接受 FLOAT VEC4。
- `meshResources.ts` 允许 POSITION/NORMAL/TANGENT，校验数量、有限值、单位长度、与法线正交及三角形内手性一致。
- TANGENT 现在由通用 `decodeGltf` 拥有并进入 `GeometryResource`；即使材质不用 normal map，也经过严格校验并安全保留。
- `decodeTexturedGlb` 不再为了绕开静态解码器而删除 TANGENT。

### 4.4 两个 Khronos 固定提交真实样本

`TextureEncodingTest.glb`：

- 固定提交 `90d7ede14c7e280af263824604b427a1ca02cb66`。
- 21,612 bytes，SHA-256 `c2f654bdf918e3cce93db3f8d8c1b008b90d3089e756c9b38149e9306b1338f4`。
- CC0-1.0；本地 LICENSE 与 upstream metadata 已保存。
- 解码 14 geometries、14 materials、14 instances、8 embedded PNG、13 semantic texture resources。
- 两个 primitive 缺失 NORMAL，生成结果逐顶点单位长度验证。

`AlphaBlendModeTest.glb`：

- 同一固定提交。
- 2,978,812 bytes，SHA-256 `37c3577d143071b42dd46e9d942b157837eb25c6340112171d7faecaa987b14e`。
- CC-BY-4.0，作者 Ed Mackey，所有者 Analytical Graphics, Inc.；LICENSE 与 metadata 已保存。
- 解码 9 geometries、6 materials、9 instances、4 embedded PNG、5 semantic texture resources。
- 9 条 authored tangent 流全部进入 RenderPacket；材质覆盖 OPAQUE 2、MASK 3、BLEND 1，实例批次覆盖 OPAQUE 4、MASK 3、BLEND 2。

来源、许可、固定 hash 和检查结果在 `packages/deep-engine/lab/assets/sources.json`。两个样本都已接入 Lab 的几何选择器、构建清单和静态服务。

### 4.5 任务范围纠正

- P2 已明确包含轻量 Shader、高频 Three 兼容、无感切换、Windows 原生客户端、Deep2D/GUI/Chart/Host、Deep Asset Package 和 Windows 发布。
- macOS、Linux、Android、iOS 已移出当前任务和完成分母。
- `packages/deep-engine-native/README.md` 与相关计划已同步当前 Windows 范围。

## 5. 本轮验证证据

最终包级门禁：

```text
pnpm --filter @bim-studio/deep-engine test
181 test files passed
1554 passed, 28 skipped
Node policy tests: 26 passed
runtime purity: 400 browser/core sources, 142 native sources, 194 resolved Windows packages
source-size: 882 files, 0 warnings, 0 failures
```

此外：

- `pnpm --filter @bim-studio/deep-engine typecheck` 通过。
- `pnpm --filter @bim-studio/deep-engine build` 通过。
- `git diff --check` 对本轮 Deep/docs 范围通过。
- 两个新增 GLB 均重新计算 SHA-256，与固定来源清单一致。

Windows NVIDIA 浏览器真机：

- `TextureEncodingTest`：单实例和 49 实例均完成 WebGPU 首帧；深浅主题检查；控制台 0 warning / 0 error。
- 证据：`test-output/deep-engine/webgpu-1789310375339.json`，构建 hash `636dd46bccf0ddbc7de1840b3371cd10941517726bdec91dc9fbfbfe41ae83a2`。
- `AlphaBlendModeTest`：单实例完成 WebGPU 首帧，40 draw calls、110 managed resources；透明/MASK 画面可见；控制台 0 warning / 0 error。
- 证据：`test-output/deep-engine/webgpu-1789310831043.json`，构建 hash `166535b67aab1d75015542fb51599a2f4ee8ecc4e99ca263e4336932d7611049`。

报告中的故意注入 shader 编译失败、device loss 等诊断属于能力探针的预期失败分支，探针自身 `success: true`；不要把这些预期记录误报成页面控制台错误。

## 6. 当前诚实状态

Deep 已是独立可运行图形内核实验：自有 RenderPacket、WGSL/PBR、纹理、IBL、CSM、HDR/ACES/Bloom、动画/skin/morph GPU 路径、GPU LOD/Hi-Z/instance/meshlet culling、流式驻留、Shader Package/DeepSL、Three 迁移桥、Windows 原生 wgpu Viewer 与基础 Deep2D 都已有纵向切片和测试。

仍不能声称：

- 完整引擎已经完成。
- 性能或画质已经全面超过 Three/Babylon。
- 已达到 Unity/UE5/Godot 90%。
- 正式 Studio 已可无感切换。
- Windows 原生客户端已经具备完整 GUI、图表、输入、网络宿主和安装包。

最新公平基准的 1024 实例、5 轮结果中，视觉相似度稳定为 `0.9065523441504932`，低于冻结门槛 `0.92`；该轮结论保持 `invalid/withheld`，禁止降低门槛。两次新复跑的 GPU P95 中位数均为 Deep=`0.458752 ms`、Three=`0.458752 ms`，旧的 `0.589824 vs 0.393216 ms` 差距没有稳定复现，因此既不能宣称性能落后已经坐实，也不能宣称 Deep 已胜出；当前时间戳量化粒度约 `0.065536 ms`，下一步需增加 pass 级计时。

像素差异稳定存在：Deep 平均亮度约 `0.2217`、边缘覆盖 `0.1540`，Three 分别约 `0.2470`、`0.1766`。已确认两边实际 BRDF 不等价：Deep 直接光使用分离 Schlick-GGX Smith 且 diffuse 乘 `(1-F)`，Three r185 使用 correlated Smith/multiscatter 与 Lambert diffuse。先用公式 golden 和冻结 shader 修正等价性，再判断性能。采样结束后 Deep 冻结画面被 dispose/unconfigure 清空的 Lab 缺陷已经修复，双侧画面会保留到下一轮或页面退出；最新证据为 `test-output/deep-engine/webgpu-1789311702958.json`。

## 7. 下一直接任务

### 7.1 Codex 当前任务所有权（持续到 2026-09-14 07:50）

Codex 继续负责 `packages/deep-engine/src/gltf/**`、Browser `src/webgpu/**`、`lab/**` 和 benchmark。先做 `WEB-01/02` 的真实资产矩阵收口，不开启 GUI、打包或平台扩张：

1. `TextureEncodingTest` 和 `AlphaBlendModeTest` 的真实 presentation texture readback、区域分析与专用门禁 `/?realAssetPixels=1` 已实现；继续完成主 IAB 真机运行和阈值校准。
2. 增加一份同时含 metallic-roughness、KHR_texture_transform、UV1 的固定真实样本；优先复用 Khronos 官方资产，保存来源、许可和 hash。
3. glTF dense+sparse/纯 sparse、normalized UV、预算、越界、取消和 ownership 已完成；下一步不要越界放行 `KHR_mesh_quantization`，除非进入独立真实资产切片。
4. 再补 clearcoat，然后按收益依次做 anisotropy、transmission、SSS；每项都要走材质合同 → WGSL → RenderPacket → WebGPU 真机 → 代表资产。
5. 用已有竞争基准定位视觉差异和 `~0.20 ms` GPU P95 差距；只优化测得热点，保持同分辨率、同画质、串行 A/B、交替多轮。

完成上述一个纵向切片后再进入 `WEB-03/04`，不要同时铺开多套半成品。

### 7.2 GLM 并行所有权（同一九小时窗口）

GLM 负责一条约九小时、允许实际开发的 Windows native 队列。文件范围限制为 `packages/deep-engine-native/**`；可以在该包内按现有边界实现和重构，但不修改跨包总架构。严格按下列顺序逐项完成，上一项测试通过后再进入下一项：

| 时间预算 | 小任务 | 验收 |
|---:|---|---|
| 0–1 h | 盘点动态 RenderPacket、resident geometry/texture/sampler/material、shader/package cache 与 device epoch 的已有代码和测试 | 在进度文档列出“已实现 / 未接入 / 真实缺口”，每条带文件和测试依据；不凭名称判断 |
| 1–3 h | 几何与实例复用 | 相同 geometry id+revision 重复提交不创建新 GPU buffer；仅实例变更只更新实例数据；geometry revision 变化只替换对应资源；旧资源按现有 retirement 规则释放 |
| 3–5 h | 纹理、sampler、material 复用 | 相同 texture 内容/revision 与 sampler 描述复用；单纹理变化不重建无关 geometry/shader；材质绑定只更新受影响项；不得把纹理像素复制到长期重复缓存 |
| 5–6 h | Shader Package 与 device epoch | 相同 package/cache key 命中；失败候选不污染 active cache；device loss 后旧 epoch 资源不可复用，新 device 能确定性重建 |
| 6–7 h | 失败、取消与回滚测试 | 几何/纹理/shader 任一上传失败都保留最后正确帧；迟到结果不覆盖新 revision；dispose 后不再提交或泄漏受管资源 |
| 7–8 h | Windows 门禁与真实 smoke | `cargo fmt --check`、相关 `cargo test`、`cargo clippy --all-targets -- -D warnings`；运行仓库已有的最相关 Windows surface smoke，不新增多设备或长稳矩阵 |
| 8–9 h | 收口；若前项提前完成可做一个 Deep2D 窄切片 | 首选矩形 clip 或 image quad 二选一，复用现有 Deep2D/display-list/pipeline，不另造 UI 框架；最后把准确代码、测试、实机证据、未完成项写入 `docs/specs/deep-engine-glm-progress-2026-09-14.md` |

每个 2 小时任务仍要拆成一个个独立断言；现有代码已经满足的断言直接记录证据，不重写。允许为明确职责拆分 native 包内文件并补完整实现，不允许只写审计报告代替能安全完成的代码。若提前完成某段，继续下一段；若全部提前完成，优先做上述一个 Deep2D 纵向切片。

GLM 不编辑本交接文档、总账、共享 ABI、Browser 包或正式 apps。发现需要跨模块合同、跨包资源所有权重构或新依赖时，停止该项编码，只记录证据和建议，交回 Codex。除表中可选的单个 Deep2D 窄切片外，不扩展到 GUI 框架、图表、网络宿主、安装器或任何非 Windows 平台。

## 8. 续跑命令

```powershell
cd D:\Documents\bim\bim-studio
git log -5 --oneline
git status --short
pnpm --filter @bim-studio/deep-engine typecheck
pnpm --filter @bim-studio/deep-engine test
pnpm --filter @bim-studio/deep-engine lab:build
pnpm --filter @bim-studio/deep-engine lab:serve
```

Lab 地址为 `http://127.0.0.1:5291/`，竞争基准为 `/benchmark`。修改 Browser 可见行为后必须实际打开页面，完成至少两轮截图审查、控制台检查并保存验证报告。

Windows native 只有在修改其 Rust/共享 ABI 后才跑：

```powershell
cd D:\Documents\bim\bim-studio\packages\deep-engine-native
cargo fmt --check
cargo test
cargo clippy --all-targets -- -D warnings
```

不要在当前轮次运行 macOS/Linux/mobile 构建矩阵。

## 9. GLM 执行护栏

- 先运行聚焦测试复现，再改根因；不要凭阅读猜“已完成/未完成”。
- 一次只交付一个可验证纵向切片。新增抽象必须消除真实重复或稳定合同。
- 任何大改前先查现有模块；本包已有大量已实现能力，禁止重复造一套 renderer、loader、cache、LOD 或 shader 系统。
- 不要把测试 mock、WGSL 编译通过、模型解码通过或首帧显示单独写成生产完成。
- 不要修改正式 app 接线，除非任务明确进入 `SWITCH-01..06` 且 P0 项目语料已经清零。
- 不要提交整个脏工作树。若后续用户要求提交，先按文件归属拆分、跑门禁、检查第三方 notice，再提交；push 仍以当时用户指令和 `AGENTS.md` 为准。
- 每次状态变化同步 `docs/active-task-recovery-ledger.md` 和权威 backlog；只用“已完成 / 本轮待办 / 明确排除 / 项目级后验收”四种状态。

## 10. 工作树提示

根工作树会在本检查点统一提交并推送；后续仍可能出现 Codex、GLM 或其他任务的新改动。每次开始先读 `git status`、最近提交和总账，禁止以“让状态干净”为目标重置、覆盖或删除任何并行成果。

用户已授权 Codex 在功能切片与门禁通过后自主管理 commit/push；禁止强推。账号、数据库/MinIO 拓扑和正式 Three 默认路径仍未修改。

## 11. 23:00 后 Codex 在途状态

三项 Browser P0 并行切片已经合流：sparse accessor 全包增至 182 个测试文件、1566 通过/28 跳过；真实资产像素门禁新增 5/5 分析与 readback 测试，主 IAB 真机专用 URL 仍待完成；benchmark 冻结画面已修复，11/11 聚焦测试和真实 NVIDIA 复跑通过，但视觉相似度仍为 `0.906552`，结论继续 withheld。GLM 按 §7.2 只改 native 包，不依赖 Browser 文件。下一主线是 correlated Smith/multiscatter BRDF 等价与 formula golden，然后补 pass 级 GPU 计时、MR/texture transform/UV1 真实资产。

## 12. 剩余任务价值裁剪

当前不能削减的最高价值链是：真实资产正确性与 BRDF 等价 → RenderPacket 跨帧资源复用/回滚/device epoch → pass 级计时和冻结等价 benchmark → Browser/Windows 同合同执行 → 正式项目无感切换。Nanite Lite 对 BIM 大场景、Deep Lights 对工业场景、Deep2D/GUI/Chart/Host、Deep Asset Package 和 Windows 发布都保留为战略 P1/P2，不因四天检查点删减。

以下内容已由用户删除出任务范围，不再排期：

- 完整硬件光追、路径追踪或依赖厂商扩展的 RT 效果。
- 对所有 Three 插件逐个追求 100% 兼容，尤其 raw WebGL、任意 GLSL 与 renderer 私有 hook；只保留冻结高频代表语料、分级兼容和机器可读 unsupported report。
- 为长尾模型格式编写新 native decoder；只把 glTF/GLB 做深，既有高频 BIM/CAD/机器人能力复用现成 converter/provider。
- 复杂 Shader Graph 产品、无限节点画布、subgraph 生态和完整 Graph IDE；只保留模板、Inspector、DeepSL/WGSL 与受约束的轻量节点表达式。
- 电影级全动态 GI、重型体积云雾和高样本静态光照烘焙；当前只保留有预算上限的 GI Lite、probe/可见性混合烘焙和资产预处理。
- 同时建设 MSI 与 MSIX、多更新通道、完整驱动年代矩阵；先交付一条可复现、可回滚的 Windows 包和 NVIDIA/AMD/Intel 各一条代表门禁。
- 原生 Viewer 的触控、多窗口和高级无障碍完善在鼠标键盘、中文 IME、文件/网络/诊断与核心 Viewer 闭环之后实施。
- macOS、Linux、Android、iOS、Unity 导入/运行兼容继续明确排除。
