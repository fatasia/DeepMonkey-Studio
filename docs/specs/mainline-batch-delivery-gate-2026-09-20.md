# 主线批次交付门禁

用户 2026-09-20 更新：加快性能、效果、能力推进，停止按小切片频繁 push。以下规则从本次更新起生效，不回退此前已推送提交。

## 批次规则

- 当前批次先完成 P0 FINAL-GATE 第一轮；R10 后续、资源快照和完整调试 UI 不阻塞此轮。性能/效果/能力按不重叠文件并行，GPU 性能采样串行。
- 本地允许按切片 commit，远端只在完整批次统一审核通过后普通 push 一次。测试修补、文档回填、单个代理结束不单独触发 push。
- 只纳入逐文件认领和验证的改动，不批量暂存整个工作树；其他会话 WIP 与未经验证的快照 helper 保留在原处。

## Push 前必须通过

1. 复核当前总账、交接、最新提交和 diff，确认没有重复建设，工作树改动归属明确。
2. 相关模块类型检查、聚焦测试和失败/恢复路径通过；共享渲染行为变化跑引擎回归，UI/渲染变化补真实浏览器/GPU证据。已有且未受影响的证据可复用，必须注明范围和代码版本。
3. `pnpm gate:repository`、`pnpm quality:source-size`、`pnpm quality:public-brand` 通过；涉及模块的构建通过。不能修改门槛、排除失败用例或只靠生成物绕过源缺陷。
4. `git diff --cached --check` 通过，暂存文件逐项复核；变更日志、能力边界、证据位置和剩余项同步更新。
5. 批次报告分别列性能、效果、能力的已验证结果和未完成项；没有整帧测量不宣称 FPS/P95 收益，没有产品链验证不关闭产品接入卡。

任何必需检查失败：继续修复，本批次不 push。首轮门禁执行结束不等于门禁通过，更不等于整个目标完成。全项目最终签核仍要求修复后两轮全绿。

## 当前失败与排除

- 首轮引擎测试：414 文件 / 3385 项通过，41 项既有跳过；脚本测试 27 项通过。随后发现的 runtime-purity 缺陷（捕获适配器直接读取 performance、readback helper 使用 DOMException）已改为宿主注入时钟与平台无关错误，并由 focused purity 检查复验；原始整条命令失败记录保留作历史。
- 产品浏览器门禁通过：3 个二维视口、WebGL 与 WebGPU；报告 `test-output/product-browser/report.json`。这是当前夹具门禁，不代表全部核心业务数据链或最终视觉签核。
- Viewer 性能采样已完成：`test-output/codex-2026-09-05/viewer-performance-LZ5XJB/report.json`；WebGL/WebGPU × 120/1000 primitives 四场景均无渲染错误，P95 为 21.3–25.0 ms，长任务为 0。WebGPU 的 `powerPreference` 是 Chrome Windows 已知警告，不计为产品错误；该夹具仍不是工业大模型或最终 FPS 承诺。
- Web delivery 类型合同已复验通过（typecheck 0 errors，合同聚焦 32/32）；整组 delivery 行为回归仍有 11 项失败。根目录 source-size 与 public-brand 已通过，但 deep-engine 严格 >300 行 source-size 仍有 70 个历史/并行文件超限，未修改门槛。所有相关检查未全部通过前不触发本批次 push。
- 不恢复跨引擎跑分、480min soak、wgpu fork。RVT 2026 新样本仅作为后排候选，深水逆向不重启。
