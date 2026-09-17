# Deep2D P2-02：ZRender Painter 批量命令实验

日期：2026-09-17
状态：隔离实验；不进入 N0，不作为兼容性承诺

## 结论

仓库实际解析版本为 ECharts `6.1.0` / ZRender `6.1.0`。ECharts 6 的 SVG SSR 模式可在无 DOM 条件下完成动态柱图布局，并从同一实例的 ZRender storage 读取稳定 rect。实验据此输出逐帧 `ChartCommandBatch`，不接收 ECharts option、函数、DOM、脚本或任意对象。

这条路径只证明“受限动态 bar 数据 → ECharts/ZRender 布局 → rect 增删改批次”成立。它没有证明完整 ZRender Painter 或 ECharts 生态能进入 Deep2D/N0。

## 依赖与现有能力

- `apps/web/package.json` 声明 `echarts: ^6.1.0`；`pnpm-lock.yaml` 解析 `echarts@6.1.0` 与 `zrender@6.1.0`。
- `packages/deep-engine/src/echartsOptionCompat.ts` 已有受限 JSON option → `ChartIR` 编译器，明确不导入或执行 ECharts，并拒绝 formatter/函数。
- `apps/web/src/delivery/dashboardChartFrame.ts` 已有 `ChartIR` → `Deep2dDisplayList` 静态 lowering。本实验不复制或替换该正式路径，只验证 ECharts/ZRender 计算结果能否形成受控的增量命令。
- `runtimeContentSha256` 复用于规范输入和完整输出快照的 SHA-256；批次的 `outputHash` 不只覆盖 delta。

## 实验合同

输入只有 `chartId/categories/values/logicalWidth/logicalHeight/domainMax/color`。类别和值一一对应，值限于 `[0, domainMax]`，颜色只允许 `#RRGGBB[AA]`。

每个成功帧输出：

- 单调 `epoch`；
- 规范化输入 `inputHash`；
- 完整已提交 rect 快照 `outputHash`；
- `upsert-rect` / `remove` delta；
- 依赖版本、预算、耗时与 blocked capability 列表。

首帧输出完整 rect；后续帧只输出变化或删除。失败帧不推进 epoch、不替换 output hash；运行时尝试从最后一次成功输入重建隔离的 SSR 实例。

## 预算

| 项 | 上限 |
|---|---:|
| 柱数量 | 256 |
| 单类别 UTF-16 code units | 256 |
| 规范输入 | 64 KiB |
| 单帧命令 | 512 |
| 硬计算时限 | 250 ms |
| 观测目标 | 16 ms |

耗时使用本地单调时钟记录。16 ms 是观测目标，不决定提交；超过 250 ms 的帧失败并保留上一 epoch。生产化前必须用固定硬件、预热轮次和分位数重新定标。

## 明确 blocked

| 能力 | 状态 | 原因 |
|---|---|---|
| formatter | blocked | formatter 是可执行 JavaScript，违反有界数据合同 |
| image | blocked | 未冻结图片加载、解码、资产身份与回收合同 |
| tooltip | blocked | 未覆盖指针命中、交互状态或 DOM overlay |
| animation | blocked | 强制 `animation: false`；未捕获调度器和中间帧 |

此外，非 rect displayable、渐变/纹理 fill、clip、transform、文本、路径和混合模式均不在本实验支持面。遇到这些输出时 fail-closed，并保留上一成功 epoch。

## 停止条件

- 不把 ECharts、ZRender、任意 JS 或 DOM 放入 N0。
- 不以 SVG 字符串解析替代受控 display-list lowering。
- 若受限动态图每帧都必须销毁/重建 ECharts 实例，实验判失败；当前正常帧复用同一实例，仅错误恢复重建。
- 若元素 identity 或批次 hash 在固定输入下不稳定，停止扩面。
- 本实验通过不自动解锁 P2-03/P2-04，也不改变正式 ChartIR/Deep2D 发布合同。

## 冻结样例证据

固定输入 `p2-02.dynamic-bar`（A/B/C，12/24/18，320×180，domain 30，`#5070dd`）在
ECharts/ZRender 6.1.0 下得到：

- input SHA-256：`ae87c2244ad8391a0ff60df6733b384492be36ae3d9864c8ad9ce6f03a17a9c0`
- 完整 rect 快照 SHA-256：`bd879f1bb9133d78390306ed560df653b7af6dc4a7b7b46ed46d2ead76111011`

测试将两者作为 golden 固定；同进程新建 10 个隔离实例重复计算，10/10 一致。`computeMs`
仅记录观测，不进入 hash。依赖升级、布局或序列化漂移会直接使测试失败，不能静默扩大认证范围。
