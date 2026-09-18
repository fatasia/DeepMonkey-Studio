# Deep Engine 主线交接给 GLM

日期：2026-09-15  
工作区：D:/Documents/bim/bim-studio

## 接手目标

继续 Deep Engine 发布主线，范围是 D01–D10：发布预检、客户端产物可靠性、资源依赖冻结和 Native 三维交付。不要扩展成 Deep2D 研发，也不要重做已有实现。

## 必须先读

1. AGENTS.md
2. docs/active-task-recovery-ledger.md
3. docs/specs/deep-engine-execution-plan-2026-09-15.md
4. docs/specs/deep-engine-next-development-tasks-2026-09-15.md
5. docs/specs/scene-client-dependencies-2026-09-15.md
6. docs/specs/scene-client-package-integrity-2026-09-15.md

开始前执行：

```powershell
git log -3 --oneline
git status --short
```

工作树有大量并行未提交改动，禁止整批暂存、回滚或格式化无关文件。

## 已完成且不要重复实现

### D01 生命周期收口

- apps/web/src/App.tsx 已压到 799 行，useAppRuntimeEffects.ts 已低于 800 行。
- 已拆出生命周期、交互和发布控制边界；先复用现有 hooks/context。
- D01 的完整双主题视觉闭环和 Kimi-95 评分仍未完成，不能把 source-size 通过当成完整 D01 完成。

### D03–D05 发布可靠性

- 发布前保存快照、CAS、历史恢复原子提交已接入 API。
- 历史恢复保留当前草稿内容；并发保存、发布、删除、恢复和写入失败都有回归。
- 撤回/删除在停止云会话后再次核对草稿与发布版本，避免迟到请求删除新版本。
- 云会话使用 apps/api/src/cloudRenderPublicationIdentity.ts 对项目、场景、版本、发布时间和完整快照做 SHA-256 身份绑定；身份写入 registry，重载后仍校验。
- Web 撤回/删除使用最新 route、active scene 和列表 getter 隔离迟到响应；新发布出现时旧撤回不显示成功提示。

### D04 ZIP / Native 校验

- scripts/verify-scene-client-package.mjs 及 sceneClientArchive* 已完成 ZIP 路径、CRC、大小、SHA、重复条目、Native 内包和报告绑定校验。
- apps/web/src/delivery/sceneClientResources.ts、sceneClientApplications.ts、sceneClientRuntimeDependencies.ts 已完成显式依赖选择和资源 hash 校验。
- 空引用不回退全项目；跨项目、缺失、未 ready、未声明脚本依赖都会阻断。

## 当前验证基线

- Web 全量：560 个测试文件，3141 通过，2 跳过。
- Web build、typecheck、bundle budget、repository gate、source-size 通过；首屏约 339.8 KiB，gzip 约 111.9 KiB。
- API 全量：153 个测试文件，761 通过；API typecheck、build、repository gate、source-size 通过。
- 日志：test-output/d05-discard-web-full-final.log、test-output/d05-discard-web-build-final.log、test-output/d05-discard-api-full.log、test-output/d05-discard-api-build.log。

## 当前第一优先级：D06 依赖版本与字节冻结

现有 SceneArtifactRecord 只保存发布快照 fingerprint：

- apps/web/src/controllers/scenePublicationArtifactRecord.ts
- apps/web/src/controllers/scenePublicationArtifactRunner.ts
- 当前重试仍会通过 sceneClientPackage.ts 读取实时 project、applications 和资源 URL。

因此当前实现不能声称旧发布重试不会混入新资源。下一片应完成：

1. 为发布版本增加受保护的依赖记录，不把完整项目配置塞进匿名 PublishedSceneRecord。
2. 记录裁剪后的 applications、project 交付字段、脱敏 runtime、资源身份、bytes 和 SHA-256，并绑定 projectId/sceneId/version/publishedAt/snapshotFingerprint。
3. 重试优先读取对应版本依赖；依赖记录缺失时明确标记旧模式或拒绝冻结重试，禁止静默读取当前项目补齐。
4. 资源字节需要内容寻址保存；仅保存 URL 或 hash 不足以保证历史重试可用。
5. 复用现有选择器、verifySceneClientResource、ZIP index 和 JsonStore 单写事务，不重写资源选择逻辑。
6. 先做元数据冻结，再做 MinIO/local 内容寻址 blob；两者分别测试和回填总账。

### 建议落点

- 合同：packages/contracts/src/scenePublicationDependencies.ts
- 纯逻辑：apps/api/src/scenePublicationDependencies.ts
- 存储接线：apps/api/src/metadataStore.ts、scenePublicationStore.ts、jsonStore.ts
- 导出接线：apps/web/src/delivery/sceneClientPackage.ts、scenePublicationArtifactRunner.ts
- 对象存储现状：apps/api/src/objects.ts。LocalObjectStore.putFile 当前是空实现，MinIO 的 stat → cp 也不是内容校验的不可变写入，不能直接宣称 blob 已冻结。

## 明确禁止触碰的范围

- 另一窗口正在做的 Deep2D ChartIR、Native 图表、tooltip、命中、窗口输入、二维运行包和专属合同。
- packages/deep-engine/src/** 的 Native/Deep2D 实现，除非先确认是本发布主线必要接线且不重复已有改动。
- 固定 admin/admin、Postgres + MinIO 权威拓扑和已有数据。
- 不得用固定夹具、Node CLI 或 Web ZIP 完整性结果宣称真实 Windows Native 窗口已通过。

## 推荐执行顺序

1. 先做依赖记录纯合同、fingerprint 和旧历史兼容测试。
2. 接入 API 单事务保存和受保护读取；补并发、缺失、跨项目、历史清理测试。
3. 接入 artifact runner；测试项目/application/resource 后续修改不会改变旧重试输入。
4. 再实现内容寻址 blob，先 local 真实字节，再 MinIO 行为和失败回滚。
5. 每片跑 focused tests、typecheck、build、repository gate、source-size，并在同一批更新 CHANGELOG.md 和 docs/active-task-recovery-ledger.md。

## 不能宣称完成的项目

- D01 完整视觉闭环、双主题和 Kimi-95 评分。
- D05 真实浏览器取消、刷新恢复和文件落盘证据。
- D06 依赖版本与字节冻结（当前仍是下一片）。
- D07–D10 正式 Windows Native 独立交付、断网启动和真实首帧。
- 与 Three、Babylon、Unity、UE5 的同资产同设备基准；没有统一实测证据不得宣称超过。

## 交接完成标准

每次交接回填：修改文件、未修改的并行范围、命令、退出码、测试数量、日志路径、已知限制和下一步。保持主目标 active，直到 D01–D10 的实际验收证据完整。

