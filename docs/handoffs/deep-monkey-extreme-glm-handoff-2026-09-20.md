# Deep Monkey Studio 极致性能、效果、AI 与双客户端交接（2026-09-20）

## 1. 恢复入口

- 仓库：`D:/Documents/bim/bim-studio`
- 分支：`dev-studio`
- 基线提交：`6699892`
- 当前策略：共享工作树保留大量并行 WIP；不得 `reset`、`clean`、`checkout --` 或批量暂存；当前用户要求不 push。
- 数据拓扑：PostgreSQL + MinIO 为权威存储；不得改用户名、密码、连接拓扑或覆盖既有数据。
- 先读：`AGENTS.md`、`docs/active-task-recovery-ledger.md`、`docs/reports/extreme-performance-ai-client-audit-plan-2026-09-20.md`、`docs/reports/mainline-product-consumption-audit-2026-09-20.md`。
- UI/3D 改动必须加载 `C:/Users/rain/.agents/skills/design-taste-digitaltwin/SKILL.md`。完整浏览器/Native 视觉闭环统一放在最终门禁，不能凭单测签核视觉完成。

## 2. 本轮已经落地

| 能力 | 实现状态 | 关键入口 | 已有验证 |
|---|---|---|---|
| 场景网格与发布 | Three 斜视各向异性提升；Deep 接受 2000×2000 正式网格；`gridVisible` 与 skybox 解耦；Three 消费 scene.json，Native 编译为 4 层 unlit/BLEND RenderPacket 网格；关闭时零几何/零 draw | `sceneGrid.ts`、`StudioDeepGridSession.ts`、`compileSceneAuxiliaryGrid.ts`、scene runtime compiler | focused 3 文件/38 项、Web/Deep typecheck；最终多 DPR 截图后置 |
| 分页虚拟几何 | 大型静态几何按 meshlet page 切分，稳定内容 ID、需求、页级上传/逐出、last-good；小场景/变形/骨骼保留低成本路径 | `packages/deep-engine/src/virtualGeometryPages.ts`、`threeBridge/authorChunkStream.ts` | focused/typecheck 已通过；GPU feedback、mega-buffer/稀疏绑定未完成 |
| G3 HLOD/residency | 相机真实帧驱动分区选择，首帧 fallback，旧 projection 释放/逐出，稳定对象 ID | Deep runtime prewarm、Studio bridge 相关文件 | focused/typecheck 已通过；真实显存下降待最终基准 |
| Web 相机相对坐标 | 作者 world double 不变；1000 网格 origin、±750 滞回、local float GPU packet/camera、revision/chunkId | `packages/deep-engine/src/threeBridge/cameraRelativeCoordinates.ts` | focused/typecheck 已通过 |
| Native 动态 rebase | GPU 场景、相机、Rapier、选择/标注原子迁移；失败回滚；阴影/Hi-Z/LOD/遥测 epoch 失效；拾取/测量保持 world f64 | `packages/deep-engine-native/src/player_content*`、`renderer*`、`native_physics*`、`gpu_lod.rs` | `cargo fmt --check`、`cargo check --locked --bin deep-engine-native` 通过 |
| RenderGraph 帧内复用 | 根据生命周期与 happens-before 复用兼容物理纹理；历史/外部/readback/并发资源排除；无消费者 MRT 5→2 | `packages/deep-engine/src/renderGraph.ts`、PBR transient target 相关文件 | focused 51 项通过 |
| 材质参数池 | 40 float/160B 稳定参数去重；连续相同 pipeline/material 避免重复 bind group | PBR packet/material binding 相关文件 | focused 32 项通过；完整 bindless/稀疏纹理未完成 |
| SSR/时域可信度 | 最多 6 层 radiance pyramid + roughness² LOD 锥采样；SSR 命中替换回退能量；TAA/SSR/DDGI/雾/接触阴影共享可信度输入 | `packages/deep-engine/src/postprocess/*` | focused/typecheck 已通过；反射探针/平面反射层级仍缺 |
| IES/PCSS/SSR 作者链 | IES 保存/编译/Web+Native；SSR 正式作者状态和 Deep 消费；spot PCSS softness 与 12 tap | contracts、Web editor/delivery、Deep/Native lighting/postprocess | focused/typecheck 已通过；能力矩阵中的不支持端保持精确诊断 |
| MCP 设置与 presence | 独立 `/system?tab=mcp`；发现、工具、能力、认证状态、复制配置；活跃编辑器 TTL/revision presence；分页 resources/list/read | `apps/web/src/components/SystemCenter.tsx`、`apps/api/src/mcpCapabilityAdapter.ts` 及 presence 文件 | MCP focused 13 项通过 |
| MCP 场景语义资源 | 对象语义、选择集、application 空间导航按 50 项分页；URI 绑定 session/draft/persisted revision，权限/TTL/revision 漂移 fail-closed；dirty draft 明确返回 persisted-editor-base | `apps/api/src/mcpEditorSceneResources.ts`、对应测试、`mcpCapabilityAdapter.ts` | focused 1/1、API typecheck、diff-check 通过；未保存浏览器草稿和写事务 driver 仍缺 |
| Shader/内容预热 | 发布预热进入真实设备 PSO cache；取消/supersede、原子发布、last-good；暴露 hit/miss/compile/abort/failure/eviction | `devicePipelinePool.ts`、`shaderPackageExecutor.ts`、`runtimePackagePrewarmAdapter.ts` | focused 15 项、Deep 双 typecheck、diff-check 通过 |
| R12 通用 GPU readback 内核 | bounded COPY_SRC buffer 与非压缩 2D texture；256B 行对齐剥离；mip/origin/region；预算、设备上限、单读、取消、超时、device loss 清理 | `packages/deep-engine/src/webgpu/frameCaptureReadback.ts`、对应测试、`webgpu/index.ts` | focused 5/5、Deep 双 typecheck、diff-check 通过；PBR 安全资源白名单与 Studio 产品按钮尚未接 |
| 双客户端历史故障 | Three WebView 已能生成真实 PE；Deep GUI subsystem 不带控制台；云 Worker 与本地打包已解耦；悬空 dashboard 引用可归一化 | API executable route、desktop build、publication actions、studio-core client apps | 历史实机证据见恢复总账；本轮最终完整页面交互必须重验 |

## 3. 本轮停止点

用户已要求本轮在写完交接后停止。所有并行实现和只读审计均已结束，没有后台代理需要等待。本轮不 commit、不 push，也不执行统一全量测试。

1. R12 通用 GPU buffer/texture readback 内核已完成；仍需把安全资源白名单接入 `PbrRenderer`，在 submit 后调度，并接 Studio 摘要/下载入口。不能把当前公共 API 写成产品完成。
2. MCP 分页语义/选择集/空间关系资源已完成；剩余是把 active editor 的未保存草稿镜像与 `SceneCommandTransaction` prepare/apply/rollback 写事务桥接到浏览器 editor driver。
3. 设备自适应画质与有界遥测已完成：真实驱动 SSR、雾、DDGI 和 LOD，带双滞回、冷却和用户覆盖；本地热点摘要最多 16 条、默认关闭、无发送逻辑。shadow/residencyBudgetScale 仅进入合同，尚未自动改写 Studio authored shadow 或并行 R9/G3 驻留预算。

交接前用 `git status --short` 和对应 agent 回报复核以上状态；没有代码和 focused 证据的条目不得改成完成。

## 4. 本轮仍未完成，按顺序继续

1. 完成上面三个在途切片并做定向 typecheck/focused；不先跑全仓。
2. 真正的 GPU 虚拟几何反馈、mega-buffer/稀疏绑定与 I/O/解压/上传预算；当前 CPU page demand 不是最终形态。
3. Native RenderGraph 真多线程 command encoding；必须证明是 executor 线程并行和确定性提交，不能用 Promise 冒充。
4. 分级 bindless/texture array 与真实纹理页驻留/逐出；当前参数池不是完整 bindless 或虚拟纹理。
5. 反射层级剩余：局部视差校正 probe、必要平面反射、环境回退；更强 DDGI 遮挡/泄漏控制；多灯接触阴影与体积时域稳定。
6. 3D 背景网格已经贯通显隐、scene.json、Native RenderPacket 与 Three WebView；仍需在最终真实客户端验证保存/加载、撤销/重做、不同 DPR/斜视/远近清晰度，以及隐藏后网格和轴线无残留。
7. R11 Native 动画状态机产品宿主、P5 空间规则持久化、P7 QTO 分类口径和结果定位。
8. MCP 截图/对象 ID+深度/性能画像/验证资源，以及真实外部 MCP 客户端兼容性、安全 annotations、幂等与冲突验证。
9. Deep Native/Three WebView 完整应用打包与真实操作；覆盖 3D、Dashboard、多页面、导航、图表、脚本、数据绑定、环境/灯光/后处理、动画、物理和离线依赖。
10. 同场景、相机、分辨率、DPR、质量档做 Web/Deep Native/Three WebView 对拍和性能比较；目标功能一致、效果相当或更好、性能有实测提升。

### 必须先处理的已知风险

- Native annotation 当前持久化 v1 只保存 local f32，不保存 coordinate frame。运行时 rebase 会平移 note/saved/draft；rebase 后保存并按作者原 frame 重开可能产生 world 位置漂移。先补 frame-aware 持久化与重开测试，再签核 Native rebase 完整闭环。
- `compileVirtualGeometryPages` 尚无直接单测。需覆盖真实大网格分页、内容 hash、顶点/属性保持、last-good 和 geometry revision 增量刷新；当前 CPU visibility demand 不是 GPU feedback。
- Web RenderGraph encoder group 仍是同线程多 encoder；Native 真多线程 executor 尚未实现。不得把 Promise 调度写成 CPU 并行完成。
- MaterialBindingPool 当前为 packet-local，尚非 device-global/cross-packet bindless，也没有真实纹理页驻留与逐出。
- 背景网格已进入发布包，但最终仍需验证保存→刷新→撤销/重做→两种客户端启动，以及不同 DPR、斜视、近远和隐藏后无轴线残留。

## 5. 最终门禁（所有实现后统一执行）

先做聚焦失败修复，再按以下顺序执行；中间失败必须修复后续跑，不能关闭门禁：

```powershell
pnpm gate:repository
pnpm quality:source-size
pnpm quality:public-brand
pnpm typecheck
pnpm test
pnpm build
pnpm gate:deep-p0
pnpm test:scene-client
pnpm gate:product-browser
pnpm gate:webgpu
pnpm gate:production-artifact
```

Native 最终至少运行：

```powershell
cargo fmt --manifest-path packages/deep-engine-native/Cargo.toml --all -- --check
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked
cargo clippy --manifest-path packages/deep-engine-native/Cargo.toml --locked --all-targets --all-features -- -D warnings
```

最终证据必须包含：样本 hash、版本、冷/热启动、打包时间/包体、CPU/GPU P50/P95/P99、长帧、内存/显存、同条件截图、逐项交互记录和故障日志。视觉按 Kimi-95 十维标准做至少两轮；当前尚未执行，不能写成已通过。

## 6. 工作树保护与暂存规则

- 不提交 `.tmp-*`、`test-output` 原始日志、缓存、凭据、客户模型或生成物。
- `packages/deep-engine/src/webgpu/frameCaptureReadback.ts` 在本轮开始时是未完成 WIP；合并前检查最终 diff 和测试。
- `apps/web/src/delivery/compileSceneEnvironment.ts` 与其测试当前是共享 untracked 文件，包含网格/skybox 解耦；不得被误删或用旧版本覆盖。
- 关键未跟踪文件还包括 `packages/deep-engine/src/virtualGeometryPages.ts`、`packetBoundsHlod.ts`、`threeBridge/cameraRelativeCoordinates.ts`、`webgpu/renderGraphEncoderExecutor.ts` 及其测试、`apps/api/src/mcpEditorSceneResources.ts` 及其测试、`packages/deep-engine-native/src/native_physics.rs`。后续 `git add` 必须显式逐文件检查，不能只看 `git diff --stat`。
- 高冲突共享文件：`pbrRenderer.ts`、`pbrPostProcessChain.ts`、`webgpu/index.ts`、根 `src/index.ts`、`DeepWebGpuBackend.ts`、runtime prewarm 文件、Native `renderer.rs/init.rs/player_content.rs`、`mcpCapabilityAdapter.ts`。这些文件同时包含多条能力 WIP，只能逐 hunk 审核。
- 共享文件 `pbrRenderer.ts`、`webgpu/index.ts`、contracts、publication/delivery、Native renderer 同时承载多条切片；逐段审查，不按目录批量暂存。
- 只对已验证文件逐项 `git add <path>`；执行 `git diff --cached --check` 和完整 staged diff 审核后再提交。
- 当前用户要求不 push。即使本地提交，也不要上传，直到用户重新授权。
