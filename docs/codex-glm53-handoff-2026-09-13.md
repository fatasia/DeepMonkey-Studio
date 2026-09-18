# Deep Engine → GLM 5.3 Flash 交接（2026-09-13 23:00）

状态：**继续执行，不得因已有 `deep-engine-glm-to-codex-handoff-2026-09-14.md` 而停止。** 该文档只是首批八项的中间检查点；GLM 每轮先读取本文 §7.3 的扩展队列，持续取下一项，直到调度窗口结束或所有可独立项完成。源码、样本、验证报告均留在共享工作树，由 Codex 统一门禁、提交和 push。

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

### 7.3 GLM 提前完成后的追加队列

当前协作门禁提示（2026-09-14 00:03）：`packages/deep-engine-native/src/deep2d/validate_commands.rs` 按仓库脚本计为 304 行，已阻塞 `gate:source-size`。这是正在进行的 clip 改动，GLM 在进入下一项前须按职责拆分到不超过 300 行；不得删验证分支或放宽门禁。

若 §7.2 提前完成，继续留在 `packages/deep-engine-native/**`，按下表从上到下执行。**本表固定为 40 个原子任务**；每项先审计现有实现，已经具备且证据充分时只回填依据并进入下一项，不得为了消耗时间重写现有模块。每轮在进度文档记录当前序号、完成证据和下一序号，不能再次以“首批八项完成”为由提前收口。

| 顺序 | 追加任务 | 验收 |
|---:|---|---|
| 1 | 动态 RenderPacket 公开更新入口 | 把现有 `Renderer::replace_render_packet` 接到 native 包内最窄公开入口；相同内容零工作，较新 revision 原子生效，非法/取消/迟到结果保留最后正确帧；不自创网络协议 |
| 2 | native 分段性能遥测 | 按需启用 CPU prepare/encode/queue-submit 与 GPU pass/frame P50/P95/P99；固定有界样本与读回槽，忙时跳样不阻塞普通帧；默认关闭时不增加每帧分配和 GPU 同步 |
| 3 | 动态场景 bounds 阴影 fitting | 复用现有四级 CSM，RenderPacket/bounds 变化后重算，静止场景稳定复用；覆盖极薄、极大、空场景和相机抖动，禁止每帧无条件刷新 shadow |
| 4 | Deep2D 两个基础缺口 | 先矩形 clip，再 image quad；沿用现有 display-list、同 device/surface/encoder、事务与回滚，不另建 UI 框架；每完成一个都运行真实 present/readback smoke |
| 5 | Runtime Package 发布预热 | 复用现有 Shader Package/磁盘 CAS，消费包内 allowlist/预热清单；命中不重建 pipeline，损坏/不兼容条目隔离并回到可编译路径，device epoch 后旧对象不复用 |
| 6 | Windows native 恢复矩阵 | 在已有 smoke 上组合 resize、最小化/恢复、device loss、动态 packet 与缓存；逐项验证最后正确帧、资源回落和退出，不新增长稳或非 Windows 矩阵 |
| 7 | Deep2D 跨帧资源复用 | 在 clip/image 已通过后，为现有 `Deep2dGpuPainter` 增加 revision/content-key 驱动的窄缓存：相同 display-list/atlas 不重建 pipeline、vertex buffer、texture 或 bind group；只变 path 顶点时不重传 atlas，只变一个 atlas 时不重建其他 atlas；候选失败保留旧 UI 帧 |
| 8 | GPU 场景显存预算与证据 | 在现有 `GpuSceneCache` 的 Weak 生命周期上补精确的 geometry/texture/instance resident bytes 和峰值；预算不足先清理失效 Weak 项，仍超限则原子拒绝候选，绝不驱逐 active scene；默认预算来自 adapter limits/显式配置并有保守上限 |
| 9 | 动态 packet 与 LOD/剔除一致性 | 复用 `replace_render_packet` 已有全候选事务，补真实 GPU 断言：实例/bounds/revision 更新同时刷新 LOD、GPU culling 和 shadow evidence；noop 不清历史，失败不发布半套状态，设备 epoch 后确定性重建 |
| 10 | 可复现 native 性能门禁 | 基于第 2 项遥测实现独立 CLI/测试入口：固定 warmup、固定采样窗、JSON 报告含 adapter/backend/build hash、CPU/GPU P50/P95/P99、资源峰值和跳样率；禁止在普通 Player 路径默认采样，先产基线不拍脑袋放宽阈值 |
| 11 | Deep2D 有界批次与 DPI 门禁 | 复用现有 z-order/chunk/scissor：只合并相邻且 pipeline、atlas、clip 完全相同的 draw；覆盖 1×/1.25×/1.5×/2× DPI 的向外取整、空裁剪、越界裁剪和 path-image-glyph 顺序；以 draw/chunk 数和真实像素双重验收 |
| 12 | 原生能力与失败报告 | 把 adapter/features/limits、降级选择、runtime/shader package hash、cache/telemetry 状态和最近恢复原因输出成稳定 JSON；错误码可机器读取且不包含用户路径或资源正文，为后续 Viewer 设置页和崩溃诊断直接复用 |
| 13 | 更新队列 latest-wins 协调器 | 为公开 packet 更新入口补纯状态机：burst revision、解析中取消、迟到候选和失败重试只允许最高已接受 generation 发布；旧 scene 在候选完成前持续可绘制，不引入线程池或网络协议 |
| 14 | IBL 环境原子热替换 | 当前环境 id/revision 变化会被拒绝；改为候选式创建 IBL、frame bind group 与相关 shader binding，全部成功后一次发布；同环境零创建，坏环境精确回滚，真实 HDR readback 证明变化 |
| 15 | Renderer 级 Shader Package executor 复用 | 将当前调用点临时 executor 提升到 renderer/device epoch 所有；相同 package 跨 packet 更新不重建 pipeline，失败候选不污染 active cache，设备重建清空旧 epoch，禁止改 Shader Package ABI |
| 16 | 设备预算自动质量档 | 基于现有 CSM/Bloom 配置和第 8 项显存证据产生确定性档位；只按顺序降低阴影尺寸/级数与 Bloom，绝不静默降 PBR 材质；高端设备保持当前默认，报告选择理由和估算字节 |
| 17 | LOD residency 动态更新 | 同 topology 下只更新 resident bits，不重建 pipeline/history；目标层缺失回退到更粗 resident，全部缺失不 draw，恢复后回到期望层且 hysteresis 不被污染；真 GPU readback 验收 |
| 18 | transform-only culling/LOD 快路径 | geometry/material/LOD profile 未变时复用 compute pipeline、静态 bounds/levels/history，只更新实例源和必要 binding；创建计数证明无重编，结果与全重建 readback 等价，拓扑变化自动回全路径 |
| 19 | 分级联 shadow dirty | 复用四级 CSM，为各 cascade 生成 caster signature；远级变化只重画受影响层，相机/灯光/MASK 变化正确失效，结果与全量重画 readback 等价，不改公共 RenderPacket ABI |
| 20 | 无效 shadow 更新消除 | 对 packet 变化分类：emissive-only、非 caster/receiver 数据不 bump shadow；transform、bounds、MASK alpha 必须失效；用更新计数和两帧 smoke 同时验证 |
| 21 | Native PBR BRDF 数值对齐 | 把 native `direct_brdf` 与已冻结 Browser separate diffuse、优化 Schlick、correlated Smith 对齐；不改 208/160/144B ABI；覆盖 dielectric/metal/roughness/grazing golden 和 offscreen pixel 容差 |
| 22 | 完整相机透明排序 | 透明批次使用实际 eye/forward 或 view，而非只依赖 yaw；覆盖平移、旋转、等深稳定 tie、镜像与非均匀缩放后的 world-bounds center；保持对象级有界排序和 BLEND ABI |
| 23 | HDR/Bloom resize 资源事务 | 复用现有 prepare/publish resize，将相同尺寸设为零工作；尺寸变化只替换尺寸相关 attachment，失败保留旧 HDR/Bloom/output 链，连续 resize 只发布最新 generation |
| 24 | Hi-Z 历史精确失效 | 分别覆盖 resize、相机突变、packet bounds/revision、device epoch：只在必需时清历史，静止帧继续复用；首帧保守可见，禁止旧 depth 导致误剔除，真实遮挡/开放场景 readback |
| 25 | indirect capacity 溢出回退 | 当 culling/LOD 输出超过 indirect 或 visible capacity 时，不越界、不截成错误画面；自动走现有保守 draw/fallback，记录降级原因，下一稳定帧可恢复 GPU 路径 |
| 26 | 提交后资源退役证据 | 对 scene、IBL、Deep2D、HDR、shadow 候选替换建立 submission 完成后的有界退役证据；active 引用永不提前释放，连续替换后 live bytes 回落，禁止逐帧 `device.poll(Wait)` |
| 27 | adapter 能力与降级合同 | 冻结 DX12/Vulkan 所需 feature/limit 检查、可选 timestamp/压缩格式与缺失时降级；错误码机器可读，高端能力不改变画质，禁止把软件适配器当正式通过 |
| 28 | surface 调度与空闲零忙循环 | 保持 `ControlFlow::Wait`，0×0、Occluded、Timeout 不连续 request-redraw；交互/恢复只触发必要帧，AutoVsync/最大帧延迟有证据；用状态机测试证明无忙循环 |
| 29 | Runtime Package 有界安全读取 | 复用 shader cache 的 owned-file 思路；拒绝 symlink/非普通文件，读取过程中严格停在 256MiB 前并检测 size/mtime/file identity 变化；覆盖 Unicode 与 Windows 长路径，不加载正文两份 |
| 30 | Runtime Package 增量差异计划 | 比较旧/新 resource index 的 id/kind/revision/hash，确定性输出 reuse/add/replace/remove；同 revision 不同 hash 失败关闭，全等为空计划，禁止新增包 ABI 字段 |
| 31 | Runtime Package CPU 候选事务 | load→完整性校验→typed decode→shader plan→Deep2D prepare 全部成功才形成 immutable candidate；任一阶段失败不改 active，取消/过期 generation 不发布 |
| 32 | Runtime Package 增量 GPU 发布 | 消费第 30/31 项，只为变化资源建候选；全部 error scope 成功后一次切换，只改 Deep2D 不重建 3D/IBL/shader，device epoch 与 generation 双重防迟到 |
| 33 | Deep2D 多子路径 | 让现有 `Move` 表达多个互不相交子路径；fill/stroke golden 覆盖，空子路径、重复 close、自交和预算超限失败关闭；不得另写 tessellator |
| 34 | Deep2D 填充孔洞 | 消费已有 `fillRule`，实现 evenodd/nonzero 的单层孔洞；同向/反向轮廓 golden，越界/自交继续明确拒绝，复用现有耳切与曲线 flatten |
| 35 | Deep2D dash/dashOffset | 将已有 dash 合同编译为有界折线段后进入现有 stroke tessellation；覆盖正负 offset、闭合路径、零长度段、DPI 与段数预算，禁止 shader 里无限循环 |
| 36 | Deep2D round cap | 实现已有 `LineCap::Round`，弧段数由 0.25 physical-pixel 误差与预算共同限制；水平、斜线、超短线 golden 和超预算失败 |
| 37 | Deep2D round join | 实现已有 `LineJoin::Round`；覆盖锐角、钝角、180°退化、DPI 和段数预算，保持 miter/bevel/square 现有回归全绿 |
| 38 | Deep2D 凸路径裁剪 | 只接一个简单凸 `clipPathId` 的最小 CPU 裁剪切片；覆盖完全内/外/相交与变换，非凸/多重 clip 明确拒绝，失败不能产半成品；矩形 scissor 不重做 |
| 39 | Deep2D CPU 命中测试 | 把已有 `hitId` 保留到 prepared item，按逆变换、fill/stroke 与 z-order 返回最上层命中；覆盖重叠、缩放、DPI、空 hitId，只提供引擎 API，不创建 UI 状态系统 |
| 40 | Deep2D DPI 原子重建 | `ScaleFactorChanged` 时按 effective DPI 重建曲线/stroke/clip 候选；覆盖 1.0→1.25→1.5→2.0，失败保留旧 UI 帧，曲线误差仍不超过 0.25 physical pixel，窗口尺寸与逻辑坐标不漂移 |

追加队列不是并行乱改：一次只完成一项，门禁全绿再进入下一项。`1–12` 是第一优先波次，`13–28` 是 native 渲染/性能波次，`29–40` 是包与 Deep2D 波次。后续项不能抢占动态更新、遥测、阴影、Deep2D image、预热和恢复主链。遇到需要修改 Browser/shared ABI、正式 app、依赖清单或发布拓扑的设计决策，只在进度文档记录建议并跳到下一个可独立完成的 native 项。

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
