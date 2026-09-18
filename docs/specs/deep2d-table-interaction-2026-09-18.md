# Deep2D 表格交互续接（进行中）

目标是让 Native 中已经显示的表格排序、翻页、CSV/Excel 按钮执行与 Web 相同的操作。复用 Web `dashboardReportView`、`sortDashboardReportRows`、CSV/XLSX 生成器；Native 只选择冻结视图并保存冻结字节，不另建报表引擎。

## 当前结论（19:55 更新：本片收口）

**表格交互切片已完成,证据齐备。** 资源压缩、正式候选、真实排序/导出/取消窗口全部通过;遗留仅浅色/空态图标最终视觉验收(另行)。

- 资源预算(已解决):R9c 4 行 linked-table 快照经位置无关压缩(origin 出内容哈希:quad 移 destination、path 移 transform 平移、非平移阵跳过;层 origin 由 Native compose 平移 adapted frame 应用)从 **146 resources / 73 nodes 降到 90 / 73**,严格逐条绘制流/几何/裁剪/atlas 像素相等证明通过(`test-output/dashboard-table-resources-r9c-20260918.json.compaction-proof.json`,packageHash 2538b4c9…);R6 2 行快照同法 117→86。预算 132/128/64 MiB 未放宽,功能未删。
- 合同:tables 视图层新增可选 `origin`(packages/deep-engine 与 Native serde/校验两侧同步,缺省兼容旧包);Native lib 测试全绿。
- C4/C5 双编译一致性(已解决):同输入两次编译要求逐字节一致。根因有二:①布局双捕获的会话微差→改为单次绑定共享(`boundData` 贯通能力报告与 worker 编译,`dashboardNativeCandidateService` 一次 `bindMeasuredLayouts`);②bundle 测量缓存漏缓存 `filterData`,致 worker 侧 `compileFilterStaticVariants` 提前返回(丢 11 个过滤变体层、zOrder 位移、缺 visibility)——已补缓存(r10f 双产物 diff 实证定位)。R10g 正式链 201,过滤 8 窗全过。
- 真实表格窗口验收(已通过):`test-output/dashboard-table-production-r10g-20260918/table-interaction/`,真实排序后 CSV/XLSX 导出**逐字节断言**×2 轮 + 取消窗,输出 "Native table export exact-byte and cancellation windows passed"(r19)。对话框自动化按截图实证改为 `GetGUIThreadInfo` 焦点 EDIT `WM_SETTEXT`+IDOK(GetSaveFileNameW 文件名框在 DirectUI 下无稳定子 HWND,键盘/UIA 方案在该会话均被拒)。
- 构建地基教训:contracts 与 deep-engine 的 dist 过期曾两次阻断(API 按生产条件解析 workspace dist,改 src 后必须重建依赖包)。

## 历史记录(R1–R10f,详见 git 与日志)

| 记录 | 结果 | 定位 |
|---|---|---|
| R1–R5 | 超时/构包拒绝 | Chromium 复用、字体复制、132 资源索引 |
| R6 | 构包拒绝并留存快照 | 145 资源,45 视图/120 表资源;207 atlas 仅 43 独立像素 |
| R7 | 409(验收器不识 tables) | dist 过期一类问题的最早出现 |
| R8b/R9c | 构包拒绝 146/73 | 压缩接线后 4 行夹具新增真实内容仍超预算 |
| R10b–R10f | C4 字节不一致 | 布局双捕获微差 + 测量缓存漏 filterData(r10f diff 实证) |
| R10g | **201 + 8 过滤窗通过** | 一致性修复后 |
| 窗口 r19 | **逐字节导出×2 + 取消通过** | 焦点 WM_SETTEXT 自动化落地 |

日志:`test-output/dashboard-table-production-rN-20260918.log`、`test-output/dashboard-table-window-r10g-20260918-rN.log`。

## 下一步(不阻塞本片)

1. 浅色主题与空态图标最终视觉验收(设计令牌核对)。
2. recovery ledger 回填(本轮已完成)。

视觉沿用帆软 FVS 的画布/表格秩序和西门子的信息纪律，令牌来源不变。本片尚未完成两轮窗口视觉验收，不给出臆测的 10 维评分；此前筛选/字体切片证据见 `deep2d-filter-production-2026-09-18.md`，不据此扩大表格完成范围。
