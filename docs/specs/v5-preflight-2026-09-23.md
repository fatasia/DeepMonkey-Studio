# V5 全量门禁预检（2026-09-23）

> 这是预检，不是最终发布放行。所有结论都引用实际命令或已有实证；未执行项明确列为 SKIP。

| 维度 | 状态 | 真实命令/证据 | 结论 |
|---|---|---|---|
| Web TypeScript | PASS | `pnpm exec tsc --noEmit -p apps/web` | 最近多轮均为 0 错误 |
| API tests | PASS | `apps/api` vitest 全量既有报告 | 235 文件/1538 测试通过 |
| deep-engine tests | PASS | `packages/deep-engine` vitest 全量既有报告 | 3935 通过/0 失败 |
| contracts tests | PASS | contracts vitest 全量既有报告 | 340 通过/0 失败 |
| Native lib | PASS | `cargo test --lib` | 最近 F4 之后 540/0；F5 收口基线 542/0 |
| Native bin | PASS | `cargo test --bin deep-engine-native -- --test-threads=2` | 最近基线 275/0；并行负载失败需串行复跑 |
| plugin-runtime | PASS | `pnpm exec vitest run --no-cache` | F6 收口后 40/40，tsc 0 |
| source-size | PASS/存量 | `pnpm quality:source-size` | 6009 文件通过；另有 Native 800/300 行存量告警，非本轮新增 |
| V1 三端 | PASS（首轮） | `npx tsx scripts/verify-v1-tri-endpoint-matrix.mts` | 3/3 端，8/8 帧，hash/GPU clean；另有 SSIM+轨迹基线 |
| V2 Native release | PASS（首轮） | `verify-scene-native-window.mjs` + release/portable evidence | 三路实窗验证通过；dashboard 错入口已 fail-closed |
| V3 Unity WebGL | PASS（首轮） | `npx tsx scripts/verify-v3-unity-webgl-e2e.mts` | Unity 6000.0.52f1，加载/材质/输入/资源/发布 5/5 |
| V4 benchmark | PARTIAL | a01x evidence + `a01x-paired-adapter.mjs` + `paired-summary.mjs` | 结构/适配/内存短跑/P99 有证；正式 30min 未跑，Babylon visual 0.8376<0.92，排名 withheld |
| V5 formal build | PARTIAL | V2 release evidence、V3 Unity build evidence | Native/Web/Unity 局部正式构建有证，最终统一重建未执行 |
| Visual regression | SKIP | 需真实浏览器/双主题/多分辨率全矩阵 | 局部 headless/截图证据存在，未跑全矩阵 |
| Fault injection | PARTIAL | Native RT fallback/device recovery/occlusion fail-closed tests | Native 关键路径有证，Web/API/发布回滚统一矩阵未完成 |
| Accessibility | SKIP | 无统一可复跑全站 a11y 命令 | 局部组件语义测试存在，未形成全站证据 |
| Offline startup | PASS（局部） | F6 npm offline + Native portable/V2 evidence | Node/Browser 离线安装与 Native portable 有证，Three 完整下载链未重验 |
| Publish rollback | PARTIAL | Native LKG/发布依赖路由/场景冻结测试 | 局部回滚与冻结包有证，V1-V5 总回滚矩阵未执行 |

## 计数

- PASS：12
- PARTIAL：5
- SKIP：3
- FAIL：0（本预检没有把未执行项伪装成失败）

## 真实剩余阻塞

1. V4 正式 30 分钟长稳与四对手完整指标合同；
2. V5 最终统一构建/视觉/双主题多分辨率/a11y/故障注入/回滚矩阵；
3. Native 音频真实输出仍是 `audio-output` fail-closed blocker；
4. V1 逐像素已建立基线，但不设置胜负线；
5. 并行工作树中存在 Native 既有改动，正式终验前需先冻结/分批收口，不能直接把当前树当发布树。
