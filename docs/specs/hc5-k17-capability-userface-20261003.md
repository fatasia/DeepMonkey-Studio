# H-C5-K17 渲染能力清单用户面与 Harness 上下文消费（2026-10-03，主线程）

## 行定义与现状核查

- K17「实际 renderer capability 清单用户面与 Harness 上下文消费，降级状态可定位」（4–8h，高优先）。
- **已有（不重建）**：contracts `RENDERER_CAPABILITY_MANIFEST`（J4 单源登记表，33 项，双端支持档+封闭原因码+文件证据）+ deep-engine 自检 + native 同形 + 金样三方对拍（既有 22 测）；`useRendererDiagnostics`/`RendererDiagnosticsPanel` 诊断面板（probe/readiness/性能/帧图已齐）。
- **真实缺口**：manifest 在产品侧**零消费**（web/api 均无）——登记表只在测试域流转；用户无法在 UI 定位"哪个能力降级、为什么"；AI 上下文无能力状态（回答"支不支持某效果"无据）。

## 交付

1. **数据叶** `apps/web/src/rendererCapabilityUserFace.ts`：从登记表派生用户面行（降级/缺席排序在前）+`degradedRendererCapabilities`+`rendererCapabilityContextSummary`（Harness 摘要，双语）。
2. **诊断面板** `RendererDiagnosticsPanel` 新增"渲染能力清单"折叠区（默认收起，受限计数前置；zh 显示标题、en 显示能力 id——英文渲染零中文既有合同；title 属性经 `rendererCapabilityEvidencePath` 只留纯路径；受限/缺席项语义色令牌）。CSS 用 base.css 令牌派生。
3. **Harness 消费**：`useAiProjectContext` 的 platformContext 装配处新增 `rendererCapabilities` 字段（summary+受限项 id/support/reason），随既有 platformContext 链流入 AI 请求——零新 UI、零合同变更。

## 验证

- userFace 3/3（单源排序/受限口径/摘要双语逐一点名）；Panel 既有 5 例零回归（含英文零中文合同）；ai 域+面板合计 23 文件 129/129；apps/web tsc 0。
- 当前登记表 33 项全 supported（outline 不在清单——Deep 无此能力，与 outline 雷修复口径一致），清单 UI 的受限路径已就绪待未来真实降级项。

## 边界

- 用户面展示登记表 web 档（运行时自检与登记表一致性由既有三方对拍测试保证，UI 不二次展示 observed 实现细节）。
- 敏感面：无。清单为只读派生，无副作用。
