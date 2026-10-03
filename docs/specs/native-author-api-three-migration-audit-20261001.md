# 原生作者命令与 Three 高频迁移：第一片

日期：2026-10-01。归属 H-C7-P3/C24，后继 H-C7-P4。当前只写 ignored 草稿，不修改正式源或任务计数。

## 现状核查

1. 全仓检索 packages/apps 的 SceneCommand、SceneMutationGateway、createPrimitive、reparent、ThreeProjectionBridge；检查 git status 未跟踪源。作者创建图元、恢复、属性修改已有真实消费；正式 PT/I23 与其他路新增源保留。
2. 契约读 scene-sdk/protocol、commandValidation、sceneCommandTransaction，contracts scene/application，Deep SceneChangeset/types。现有 SceneCommand 支持属性、材质、相机、动画，不含创建、删除、父级修改。SceneChangeset v1 仅 transform/hidden。SceneTransformGraph 已有 create/reparent/removeSubtree/同步原子 transaction/flush，唯一权威图不重建。
3. package.json：scene-sdk 只有 contracts 运行依赖；Deep 的 Three 0.185.1 是桥接/开发依赖，已有 app/webgpu/gltf/three-bridge 子入口。复用 TypeScript/Vitest，不添加渲染器或新依赖。
4. 消费方：Web SceneCommandExecutor → ViewerSceneCommandPort；EditorSceneWriteDriver → 既有 SceneCommandTransaction；API mcpEditorSceneTransactionBridge 转发该作者事务。Deep SceneMutationGateway 没有生产调用方，仅单元测试和导出；原生作者事务与该图未接通。SceneTransformSpatialBridge 已把 graph.flush 增量传入 LooseOctree/VisibleWorkingSet。ThreeProjectionBridge 已投影几何/材质/纹理/实例/变形，Three 灯光和相机桥已有。
5. 测试与证据：scene-sdk/sceneCommandTransaction.test.ts 有准备、权限、CAS、失败 rollback、取消；Deep graph/spatial/changeset/gateway 与 ThreeProjectionBridge 系列已有 CPU 测试。此前作者 PT 两 fresh 属 I16，不替代新作者命令验收；现有 Three 测试不等于 P4 的 20 题真实任务基准。
6. 规格：校准 ai-first-framework-and-agent-integration-20260930、ai-native-3d-upgrade-plan-20261001、remaining-tasks-estimates P3/P4、恢复台账、09-30/10-01 handoff。用户现有自由脚本授权仍沿 H-C6-S1；本片不引入逐命令审批、第二 SDK 或第二状态树。

**已有（不重建）**：作者状态/历史/保存，SDK 命令安全解析和事务，原生图结构与空间增量，Three/GLTF 渲染投影。

**真实缺口**：结构编辑没有 SceneCommand 合同与宿主映射；Deep 图尚无 SDK 事务 driver；既有桥不是独立原生创建 API。P4 缺的是可运行迁移交付与真实任务证据，不是再建 Three 投影。

## 最小实现边界

先做一个结构编辑命令 object.set-parent：同场景对象目标、可空 parent、显式 keepWorldTransform；保留 graph 的循环/奇异矩阵/深度校验。复用 SceneCommandTransaction 的权限、CAS、取消及失败恢复决策；薄 graph driver 只承担宿主应用与逆操作，调用既有 graph.transaction，不再写一套事务调度。

两个消费 seam：SceneCommand 安全解析 → 既有事务 → 原生 graph driver；成功 flush → 既有 SceneTransformSpatialBridge → 实际 LooseOctree 查询。编辑器 Viewer 没有原生重设父级端口，此片明确 unsupported，不通过改 Three.parent 绕过作者状态。创建/删除/材质/相机原生统一消费、编辑器接线、CLI 保存重开与 P4 20 题仍为后继。

草稿与 CPU 证据目录：test-output/native-author-api-20261001/。新叶不超过 300 行；正式源保持冻结，root 审查后决定提升范围。

## 第一片实跑

既有正式 CPU 同族 SDK 45/45、Deep/Three 四文件 41/41。新草稿复用原解析器和事务调度：11/11 Vitest、candidate TypeScript（含可提升测试）通过；Node CLI 同执行路径四项通过。正式旧 validator 对 object.set-parent 返回 Unsupported command type，before-receipt.json 保留真实缺口。

真实消费包括 SDK→graph.transaction→reparent→flush→SceneTransformSpatialBridge→LooseOctree：keep-world、detach、顺序 transform+parent、镜像非均匀旋转父级、取消后逆操作、循环与奇异父级拒绝、未 flush 并行编辑保护。失败和取消交给现有 SceneCommandTransaction 决定；driver 只保存临时逆操作，不持有场景树。finalFlush 在事务 outcome 确定后才发布，取消不向消费方发布中间状态。

最终 promotion-manifest.json 八项：scene-sdk 的 protocol/commandValidation/sceneCommandTransaction；Web SceneCommandExecutor 明确拒绝未接通的层级编辑；Web host 的 SceneGraphTransactionDriver 与真实合同测试；scripts/native-author-parent.mts；Deep examples/three-author-parent-migration.mts。manifest SHA `60d488c08d402c9d4fd9e0c5ed0e1a9bf04eb235bf74a3408c8eb9694be2f236`。新 host 叶 90/111 行，CLI/迁移例均少于 50 行，Deep 核不依赖 Scene SDK。草稿 formal-test imports 只引用正式包和同族叶，没有 ignored 路径。完整作者行、创建/删除、编辑器层级保存撤销、实际视觉与 P4 仍未验收。

正式 CLI 草稿接受 `--nodes` 的既有 SceneTransformNodeInput<string>[] 与 `--request` 的既有 SceneCommandTransactionRequest，没有另立世界文件协议。真实非固定示例输入 west/east/tool（位置 -7/23/5）被 SDK 事务重设父级后 tool 世界位置28，实际空间 bounds=[26,30]；取消与迟到 revision 保持原状态，三项通过。前述硬种子薄脚本仅为初始四项调试例，最终 CLI 使用用户输入。

Three 高频迁移消费直接运行已有桥：BoxGeometry/SphereGeometry、Group、MeshStandardMaterial 两实例；SDK 父级变更由 graph authorTransformResolver 进入实际 RenderPacket，box 世界 x 从 -2 到4，原 Three.parent 保持作为可重建渲染投影。已有 Directional/Point light 与 PerspectiveCamera 桥消费光照和50°相机；实际 onBeforeCompile 返回 unsupported。真实 candidate bundler 消费 CLI123/Three637源叶并记录 SHA，consumer-receipt.json 留存；没有 GPU 或20题验收声明。两例采用正式目标路径导入，root 提升后再直接运行，candidate 路径重定向仅用于 ignored CPU 验证。

可复跑命令（仓库根）：

```powershell
node node_modules/vitest/vitest.mjs run --config test-output/native-author-api-20261001/vitest.config.mts
node packages/deep-engine/node_modules/typescript/bin/tsc -p test-output/native-author-api-20261001/candidate-typecheck.json
node test-output/native-author-api-20261001/cli-check.mjs
```

提升后的直接入口：

```powershell
node --conditions=development --import ./apps/api/node_modules/tsx/dist/loader.mjs scripts/native-author-parent.mts --nodes test-output/native-author-api-20261001/cli-nodes.json --request test-output/native-author-api-20261001/cli-request.json
node --conditions=development --import ./apps/api/node_modules/tsx/dist/loader.mjs packages/deep-engine/examples/three-author-parent-migration.mts
```

## 根路正式提升与入口复验

根路已提升第一批7项，报告 SDK 正式93/93与 build 通过。首个正式 Web 测试失败暴露 candidate 路径 alias 掩盖 exports 边界：Deep 没有公开 `/spatial`，LooseOctreeIndex 应从既有公开根导出读取。根路以独立 amendment 修测试 import；失败保留，不把 candidate 的解析成功当公开 API 证据。

本路已无 bundle/alias 直接实跑正式 scripts/native-author-parent.mts 三项：提交 world28/bounds[26,30]、取消退出1且原 parent 保留、迟到 CAS 退出1且原 parent 保留，formal-cli-receipt.json 通过。第8 Three 例已由根路单独提升并直接 Node/tsx 实跑：Box x−2→4、双材质/双几何、directional+point 与50°camera消费、原 Three.parent 保持、unsupported hook 均通过，日志 jc-i-20261001-three-migration-formal.log。根路正式 Web 三文件19/19、SDK93/93/build、Web tsc、Deep src/lab/examples typecheck/build 全部通过。原父级模板与迁移例均已正式可运行；完整 P3/P4 保持开放。后续冻结变动采用独立 amendment，不原地扩归档 manifest。
