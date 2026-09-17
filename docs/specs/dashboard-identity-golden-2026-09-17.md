# P0-07 切片 A：跨语言 Dashboard 身份 golden（2026-09-17）

对应交接阶段 2 P0-07："同一 producer 输出在 Web/Native 的对象/资源身份比较"。本片建立**结构与身份** golden（不涉像素与坐标数值），是完整三端 golden 的地基。

## 机制

- `packages/deep-engine/fixtures/dashboard-composition-identity-golden.json`：入库的唯一仲裁。内容为 v5 组合包 `dashboard-composition-v1.json` 解析后的结构视图：package 三身份（packageId/packageVersion/packageHash）、entrypoints 全表、9 个 payload 的类型化视图（kind/revision/schema + 各类型专有身份：dashboard 页数与入口、render-packet 四类计数、deep2d 图集与 quad id 清单、chart/sim 身份）、9 个 resources 的 id/kind/revision。
- `packages/deep-engine/src/runtimePackage/identityGolden.ts`：TS 侧共享导出函数 `dashboardIdentityGoldenView`；`scripts/generate-dashboard-identity-golden.mts` 复用它从夹具重生成 golden。
- `packages/deep-engine/src/runtimePackage/identityGolden.test.ts`：TS 解析视图必须与 golden 全等；身份组独立断言（漂移时直接指向漂移组）；重复导出字节稳定。
- `packages/deep-engine-native/tests/dashboard_identity_golden.rs`：Native 侧先用完整校验器加载包（package_id/version/hash 与资源索引逐项对 golden），再按与 TS 相同的 kind 判定规则从包 JSON 导出视图比对 golden.payloads；篡改任一 payload 身份必须破坏视图。
- 语义对齐细节：TS 视图中 `undefined` 身份键经 JSON.stringify 省略（组合包 render-packet 无 revision），Rust 侧保持同一语义只插入实际存在的键；排序用 ASCII 安全序（id 集合均为 ASCII，TS localeCompare 与 Rust sort 结果一致）。

## 测试与门禁

- TS：runtimePackage 目录 317 项全部通过（含新增 3 项）。
- Rust：`--test dashboard_identity_golden` 2/2 通过；clippy `-D warnings` 干净；fmt 干净。
- 诚实边界：deep-engine 包级 `pnpm test` 当前被 sourceSizeGate 既有违规阻断（chart_render.rs 748 行等十余个 native 文件，均为并行会话在途工作，非本片引入）；本片文件总计 239 行，各自聚焦门禁全绿。

## 明确未完成（不标成完成）

- 交互轨迹 golden（tooltip/legend/filter/换页命中与状态轨迹）与值归一化合同行使未做，需 G01 宿主与数据通道就绪后接续。
- 像素级跨端对照归 P0-08，不入本片。
