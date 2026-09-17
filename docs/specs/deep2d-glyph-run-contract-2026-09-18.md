# P1-18 切片：TS 侧字形运行合同与文字像素出口（2026-09-18）

对应 [Deep2D 剩余任务](deep2d-remaining-tasks-2026-09-16.md) P1-18 的 TS 侧缺口：`Deep2dCommand` 只有"未成形文字"（fontId），Native `validate_text` 要求 `atlasId+bakedGlyphs`，因此任何 TS 生产者下发文字命令都会得到"TS 校验通过、Native 拒收"的伪支持产物。本片补齐合同，解除 P0-01 文字像素编译的阻塞。

## 合同变更

- text 命令新增可选 `atlasId`、`bakedGlyphs`（每 glyph `{cluster, source[4], destination[4]}`）——**逐字段镜像** Native `command_types.rs:168-193`，未发明 Native 不认识的字段；齐全性、cluster 递增且小于 UTF-16 长度、source 正面积在图集内、destination 有界、262_144 预算等校验规则与 `validate_text.rs` 一致。
- 显示列表新增可选顶层 `atlases`（glyph→r8unorm / image→rgba8unorm-srgb 配对），与 Native `types.rs:29-32` 的缺省语义一致；旧显示列表逐字节不变（向后兼容测试覆盖）。
- 文件拆分满足 ≤300 行门禁：`deep2dDisplayList.ts`(223) / `deep2dDisplayListText.ts`(179) / `deep2dValidationPrimitives.ts`(102)，原 API re-export 不变。

## 出口与接线

- `apps/web/src/delivery/dashboardGlyphRun.ts`：`buildTextGlyphRunCommands` 纯函数——实测度量表必填（禁止声明式估算冒充），逐行守卫镜像 Native 校验，产出保证过 TS 校验器（end-to-end 测试实证）。
- `dashboardWidgetContent.ts`：`lowerDashboardWidget` 新增可选度量表参数——有度量→产出字形运行命令并登记 compiledFields；无度量→保持既有 P1-18 deferred 登记，不冒充支持。
- `compileDashboardContent.ts`：条件汇入顶层 `atlases`（空时省略，内容哈希不漂移）。

## 测试与门禁

- deep-engine：display list 校验新增 10 例（完整字形运行/缺键拒绝/空 glyphs/向后兼容/cluster 越界/预算/发明字段拒绝等），包 vitest 3108 项全绿；golden 13 例不回归。
- web：typecheck 通过；`dashboardGlyphRun`(8)+筛选接线+内容编译聚焦 33 项全绿；web 全量 3554 项此前基线全绿。
- 顺带修正 `identityGolden.ts` 的 `packageVersion` 类型（`number`→`string`，与 golden fixture 实际值一致）。

## 明确未完成（不标成完成）

- 筛选选项文字**尚未在 Native 端渲染通过**——GPU/像素证据属后续切片；本片只保证 TS 产物可通过双侧校验。
- 能力报告口径未动：`textPass.glyphRun` 仍按 deferred 登记，没有任何对象因此改标 supported。
- 实测度量表的生产来源（P1-17 measure 接线）仍是上游依赖。
