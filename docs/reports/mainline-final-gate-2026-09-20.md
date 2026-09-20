# 主线 FINAL-GATE 首轮预检（2026-09-20）

当前为本轮待办，尚未进入两轮全绿签核。此报告区分已有切片证据与项目终验，不把索引脚本退出成功当作功能全部通过。

## 已完成的检查

| 项目 | 当前证据 | 结论边界 |
|---|---|---|
| R10 F04/F05 | `8dc7b14` | revolute 与三段链 native/WASM 位级一致 |
| R10 F06 | `fe18a12`；`test-output/r10-f06-motor-limits-20260920-r1/evidence.json` | 241 帧、双跑与去掉马达/限位负对照通过；Rust 定向 10 项通过，不包含产品宿主 |
| R12 render-loop | `726d8fd`；`test-output/r12-frame-capture-1789882287963/evidence.json` | 真 GPU 四场景各两帧；独立 package draw/readback 成功，不等于内置 PBR 来源追踪或视觉验收 |
| 仓库治理 | `pnpm gate:repository` | 5 项测试及治理检查通过，未豁免条款 |
| 主线八项索引 | `test-output/final-gate-20260920-r1/closure.json` | 合同有效，5 passed / 3 partial；本轮重新读取证据，不重跑历史场景 |

八项索引通过项为剖切、固定动态运行包、Nature Kit、发布 OS 证据和固定 GI 对拍；其各自范围保持原报告边界。部分完成项为项目后验收、工业 S1–S6、资产源级 readiness，不以 5/8 表示全项目完成率。

R12 后续来源追踪真 GPU 已通过：`test-output/r12-frame-capture-1789882931950/evidence.json`。SSR-only 场景中实际非 SpatialAA present 的 exact WGSL SHA-256、两个入口的 generated line 与跨帧查询均通过；direct/defaults/transparent 未映射来源保持为空。来源是生成 WGSL 入口，不是作者级 ShaderGraph 节点。

该增量定向 4 文件 / 29 项通过，覆盖错误管线身份、来源冲突、外部注入、预算、入口缺失/歧义、draw 失败及关闭捕获；deep-engine 核心与 lab 类型检查通过。

## 本轮待办与执行顺序

1. 收尾 R12 当前来源追踪：元数据必须来自实际创建的 WGSL module 与实际执行的 pipeline。用户配置的任意 package/map 不构成内置 PBR 的来源证据。按用户最新排序，随后先推进高收益底层优化与核心能力；完整消费、产品接入、调试 UI 与保存恢复留到功能末尾的集成阶段。
2. 先收拢并行 delivery 合同，再做完整 Web 验证。单次 `pnpm --filter @bim-studio/web typecheck` 仍失败：raster 输入缺 tableViews/filterData/textRasterScale，host 缺 prewarmText，数据/raster 导出不匹配，SceneClientPackageOptions 缺 branding，发布回调参数与下载格式 web 未统一。不得只放宽类型或删除断言。
3. 修复项目级门禁：`scripts/fixtures/rvt-source-statistics.rs` 1075 行超过 800 行；公开品牌隔离仍被 DocsCenter 构建内容、api-reference 文档及研究脚本引用阻断。拆分按职责，品牌检查保留规则，生成物应从修正后的源重建。
4. 功能切片收口后执行性能/效果/确定性/核心用户流终验；修复发现的问题后复验该段，最终两轮全绿。当前未重跑 Web/Native 全量、视觉与全站浏览器门禁，遵循用户“非必要测试后置”。

R10 后续是 MultibodyJoint、速度模式/扭矩预算、运行时控制更新与产品 PhysicsWorld 宿主。P1 性能/效果/能力缺口仍按交接清单推进，本报告不删除或替代它们。

## 明确排除与历史口径

- Babylon/Unity/A01-X 对比、480min soak 已取消，不重启，也不作为 FINAL-GATE 阻塞。
- RVT 2026 深水逆向保持排除，不用资产 readiness 的旧描述恢复该车道。
- 旧 `d24-d28-evidence-20260919` 中 V01 对手矩阵与长稳描述是历史记录；索引目前原样保留，因此其 gap 文本不能直接生成当前任务。有效剩余门槛仍含故障恢复、产品视觉/可访问性与综合签核。
- 没有执行的门禁不记通过；固定夹具不扩大为任意客户项目能力。

## 复现

在仓库根目录执行 `pnpm gate:repository`、`pnpm --filter @bim-studio/web typecheck`、`pnpm quality:source-size` 和 `pnpm quality:public-brand` 可核对当前预检结果。主线索引用 `MAINLINE_CLOSURE_OUTPUT=test-output/final-gate-20260920-r1` 指定新输出后执行 `pnpm verify:mainline-closure`。
