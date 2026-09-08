# Codex → GLM 交接（2026-09-08）

## 已完成

本轮 3/4/5/6 及必要 1/2 修补已收口：正式画布记录表单、REST/PG 写回、实际 PDF、UI/窄窗、环境视口、SIM 时间线与 Study、AI 当前页草案、必要 Vapor、旧 glTF 材质全链路、素材首帧缩略图。权威结果见 [最终统一验收](final-unified-validation-2026-09-08.md)。

最终代码在内层仓库 `D:\Documents\bim\bim-studio` 的 `dev-studio`。接手先执行 `git status`、`git log -12 --oneline`，不得重复建设。固定 `admin/admin`、`.env`、PostgreSQL + MinIO 拓扑、原场景和原模型字节不可改。

## 验证基线

- 根 build/typecheck 通过；Web 438/1827、API 132/597；2194 源文件全部 ≤800 行。
- 浏览器证据目录统一在 `test-output/codex-2026-09-05/`；具体目录和诚实边界见最终验收及各模块报告。
- 旧材质只在实际命中 SG 扩展时迁移；现代文件不重写，未知 vendor 扩展必须失败。不要删除 `CompatibleGLTFLoader` 的现代快速路径或 API 的 preflight。
- 已知的 X4122 驱动警告和官方 prune 警告有精确分类；禁止扩大正则或宣称绝对零 warning。

## 明确排除

- 用户本轮暂停行业包扩充、素材新增/审批和模板数量扩充；不要自动恢复。
- GPT 接入、协作功能、认证 OLP/动力学、完整控制器矩阵和 8 小时 WebGPU 长稳不在本轮。
- `docs/shader-workbench-integration-plan-2026-09-06.md` 与 `docs/vapor-mode-performance-plan-2026-09-06.md` 是 GLM 未跟踪草稿，本轮未纳入提交；先由用户决定是否采用。

## 下一步建议

若用户恢复行业内容，先做少量高质量行业包与素材审批，不追求凑数量；每个样本保持许可、原字节、真实缩略图、导入—优化—场景—发布证据一致。SemaPLC/Astral3D 结论直接复用 [既有分析](semaplc-astral-value-analysis-2026-09-05.md)。
