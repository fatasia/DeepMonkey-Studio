# DE26 证据索引(A08 自动生成;同输入同输出,勿手改)

来源清单:docs/specs/deep-engine-execution-tasks-2026-09-16.json(82 卡)

## A01 · 冻结五引擎目标矩阵
- 状态:已完成(完成日 2026-09-17)
- 说明:判定合同 v2 冻结:五矩阵独立判定/固定分母/排除项不计数/权重防篡改/unlocked 永不通过;真实 verdict 待 A04/A05-07 提供版本与观测
- 证据:
  - [x] `packages/deep-engine/src/benchmarkTargetMatrix.ts` sha256=1a4c24b179f1723c800415e2f061b75c635a990612b7ee72ae841f3803179ae4
  - [x] `packages/deep-engine/src/benchmarkTargetMatrix.test.ts` sha256=a36fb747120c063642c3540650903ea86e19a27793ab27f5d3cacc4756abbe78
  - [x] `docs/specs/de26-a01-target-matrix-v2-2026-09-17.md` sha256=9d3e7b4e2f7540a7a08f6e12054ab67d0c8536a6e7f085e72aca2517833b1aaf

## A02 · 冻结真实资产与交互轨迹
- 状态:本轮待办
- 说明:第一批:合同v1+三真实RVT项目(实测SHA-256,不可再分发标注);factory/far-origin 域资产与轨迹夹具待补
- 证据:
  - [x] `packages/deep-engine/src/benchmarkAssetManifest.ts` sha256=76aafedfff6e09abce443eac12935e1c39f914b1e79bafe960c4dfbbac5345ff
  - [x] `packages/deep-engine/fixtures/benchmark-assets/manifests-v1.json` sha256=5102b560fd1c680533c00584b015f893c5cde7a60a6422d67b2e962848be2ef5
  - [x] `scripts/generate-benchmark-asset-manifests.mts` sha256=3afa5185c624052b944d49c95130fed5f782aa0f49f08f0220b65f1d95d6a26c

## A03 · 统一CPU/GPU/呈现采样
- 状态:本轮待办
- 说明:TS 合同 v1(8通道/unavailable禁伪零);native telemetry_gpu 与 StudioDeepPerformance 接线待下一批
- 证据:
  - [x] `packages/deep-engine/src/benchmarkSampleSchema.ts` sha256=683e4abfe98414774b4c42940f13f059de512edc20419812183d3e879d21dfa9

## B01 · 统一场景变化所有权
- 状态:本轮待办
- 说明:变化集合同+节点级CAS+撤销同通道已提交;Three 侧投影消费(B02)与 GPU 缓存键控接线待做
- 证据:
  - [x] `packages/deep-engine/src/scene/SceneChangeset.ts` sha256=6cfaafde7fbe920cb8054e1a2fe987f372c4255a9c7b4712a7634465ccb3137c

---
覆盖 4 卡;证据缺失 0 项。
