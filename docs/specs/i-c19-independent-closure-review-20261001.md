# I-C19 keptMips 与作者消费独立复核

当前权威任务表第 80 行可以关闭：剩余 keptMips 生产采样钳制与作者面板消费均有实际接线和对应证据。自动全局预算与 LUT 跨代共享必须另列后继；本结论不扩大到其他宿主。

## 现状核查

1. 全仓检索 `keptMips/specularMipSelection/droppedMips/environmentSpecularMips`，包含未跟踪叶。生产上传、生成、binding、WGSL 与作者叶均已存在；并行改动和保护项保持原样。
2. 类型层：contracts `SceneEnvironmentState.environmentSpecularMips?: number`、sceneValidation 的 1..8 整数校验、PbrEnvironmentSource.keptMips、StudioEnvironment.specularMipSelection、EnvironmentMipSelection 已存在。默认缺省保持完整链。
3. 依赖层：Three 0.185.1、WebGPU types/Vitest/esbuild 为既有依赖，无新依赖；复核未改 package/Cargo 配置。
4. 消费方：viewerEngineRig → scene.userData → source capture/prepare/current identity → StudioDeepEnvironmentSession.stage → PbrRenderer.stageEnvironment/createPbrEnvironment → uploader/generator → PbrMainBindings → 实际 sceneShader 的 deepPbrReflectionRadiance 全链已读。keptMips 变化独立失效，即使 HDR 像素未变化也会重 stage。
5. 测试与证据：读取新采样、上传、生成、binding 回滚、源失效、select 和保存校验测试；读取 GPU receipt 两 fresh 数值及 14 个 source hash；查看作者裁剪图。独立聚焦 CPU 重跑总计 105/105 通过。
6. 规格层：按 remaining-tasks-estimates-20260930 第 80 行、i-c19-production-kept-mips-20261001、i-c19-dynamic-ibl-cpu-20261001、glm-handoff-20261001 与恢复 ledger 校准。旧 CPU 规格里的 wired-followup 已由本次生产接线和新 receipt 覆盖。

已有（不重建）：CPU budget/lease 状态机、GPU 上传/预滤波、真实帧事务、双缓冲绑定、作者保存与热替换。

真实已补缺口：物理链尾驻留、原粗糙度域重定基、环境/探针各自的 mip 偏移、作者保存档位与源身份失效。

## 生产行为与证据

prefiltered 仅上传 `.slice(droppedMips)`；HDR/studio 仅分配和生成 keptMips 层，生成参数使用原始 level。实际 WGSL 使用 `clamp(roughness*(keptMaxLod+droppedMips)-droppedMips,0,keptMaxLod)`，完整链 dropped=0 保持旧语义。反射记录 reserved 行携带独立 global/probe offsets，绑定布局不扩张。

metadata 位于同一个冻结 environment 对象。PbrEnvironmentState 只有成功提交帧才退休旧环境；失败恢复旧对象并重绑其 offsets，候选整体释放。PbrMainBindings 先创建新 binding 并写 inactive buffer，再交换索引；写入失败保留旧 binding。CPU 已覆盖偏移恢复、inactive 写失败、提交失败、取消及资源回收。

`test-output/i-series-1001/dynamic-ibl/evidence.json` 的 passed/stable/gates/sourceFresh 为 true，独立重新计算 **14/14 source hash 匹配**。每轮 sharpClampError=0、roughPreservationError=0、hdrTailError=0，sharpSignal=0.3770751953125；实际/预期节省均 261120 bytes；A→B→A 差 0，dispose 租约 0，deviceErrors 空。它通过真实 PbrRenderer 生产路径，使用 per-mip 不同常数指纹证明采样行为，不只是 finite。

作者合同保存 1..8；完整档删除字段，非法值不写入，非 Deep 禁用。已查看 `test-output/i-c19-author-20261001/round-2-detail.jpg`：348×174 控件裁剪，清楚显示“轻量 · 4 层”。主线工具记录的两轮 1920×1080 深色整页截图、保存后整页 reload 保留4层、SPA manager→editor 重入球体/Deep/4 enabled 通过，为主线验收证据；本复核没有重新操作浏览器。裁剪文件不能标注为整页截图。

## 独立 CPU 检查

- engine 7 文件 **73/73**：environmentMipSelection、prefilteredEnvironment、hdrEnvironment、pbrMainBindings、pbrEnvironmentState、pbrReflectionProbes、DeepWebGpuBackend.environment。
- author source/select 2 文件 **21/21**；既有 session 失败重试 1 文件 **2/2**。
- contracts 保存型 mip 校验 **9/9**。
- 日志及重新计算的 hash 对照：`test-output/i-c19-independent-review-20261001/{engine,author,session,contracts}.txt`、`source-hashes.json`。未运行 GPU/Cargo，未改生产源码，未 commit/push。

## 严格关闭范围与后继

可以把当前 I-C19 行改为“已关闭：keptMips 生产链尾资源/采样钳制、作者保存档位与源失效消费；Deep WebGPU；两 fresh GPU+作者 reload/SPA 验收”。GPU receipt 明确排除自动全局预算/LUT共享、其他宿主；14-source guard 覆盖该 runner 声明源码集合，不是全仓或所有递归依赖身份声明。

仍需独立后继：将 GPU 资源与 DynamicIblResidency 的预算决策真正关联，覆盖旧 active+候选峰值双驻留、预算拒绝与自动降级；生产 BRDF LUT 跨代共享与引用/释放所有权。目前 GPU upload/generation 每个候选均创建 LUT，没有生产 `new DynamicIblResidency` 消费方。CPU budget/lease 的正确性不能充作这一 GPU 接线完成证据。

边界：作者档位是显式 1..8，默认128底图有8层；自定义64底图仅7层，显式超源链档位 fail-closed。当前行没有要求自动质量策略、其他宿主或全部设备矩阵。
