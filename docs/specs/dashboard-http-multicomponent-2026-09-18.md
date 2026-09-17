# P0-06 切片：多组件中文页面 HTTP 真实交付验收（2026-09-18）

对应交接 P0-06："Dashboard 动态包真实发布与离线启动，不能借用三维或纯 demo 报告"。本片把 [标题图表交付](dashboard-http-heading-delivery-2026-09-17.md)（dfb38f0）的验收模式扩展为 5 组件中文页面。

## 页面与链路

960×540 单页 zh-CN，5 组件：中文横幅 text「冷热电联供园区运行总览」、value KPI「总有功功率/MW」、filter「区域筛选」、bar「分区域出力/MW」（华东 37/华北 91/华南 58）、table「机组运行表」（中文表头）。字体 Noto Sans CJK SC Regular/Bold（OFL-1.1，notofonts/noto-cjk，SHA 登记）。

全链：编译器构建+tsc → 真实 HTTP 创建/编辑/发布/公开读（revision 2，落盘重开一致）→ 候选冻结（3 个数据组件 + 2 字体绑定）→ ChartIR 数据逐值核对 → Native 窗口验证（RTX 4060/Vulkan，5 组件全部呈现）→ HTTP 三格式下载（ZIP/DMDA/单EXE，SHA 逐项登记）→ 无 Node PATH 环境 EXE 无参数打开 + ZIP/DMDA 离线真实打开（3 帧 Vulkan）→ 三载体真实窗口截图（中文可读、柱高正确、内容一致）→ 失败路径（非法 EXE 查询 400、候选删除后 404）。

证据：`test-output/dashboard-http-multicomponent-20260917/`（53 项 SHA-256 清单、3 张窗口截图、player 日志）。脚本：`scripts/verify-dashboard-multicomponent-portable.mts` + `scripts/lib/dashboardMulticomponentFixture.mts`（复用既有 acceptance HTTP 库）。共 9 轮运行，最终证据为第 9 轮全绿。

## 发现的缺陷（如实登记，未在本片修复）

1. **P1 图表标题窗口不可见**：标题图集证据成立（`atlas-inspect/` 中文"分区域出力"/"MW"渲染完美、player 计数含 image quads），但三张真实窗口截图中标题均不可见——疑似 native 图表层合成顺序/裁剪语义问题，需渲染器专项定位。**注意 dfb38f0 系证据仅有日志计数未含窗口像素，本片首次暴露此差距**。
2. **P1 KPI/表格测量采集缺口**：布局采集宿主只查询 `data-dashboard-capture="chart"` 根，value/table 无法进入测量静态视图 → 能力报告 blocked（容器背景矢量呈现、数字/表头缺失）。API 合同白名单已含 value/table，属宿主实现缺口（G04 切片 B 宿主已具备合同能力，待扩展捕获页根）。
3. **P3 轴标签/图例未呈现**：ChartIR 含 axes/legend，窗口无华东/华北/华南标签。
4. EXE 内真实输入未驱动（筛选命中区已编译，消费归 G01 宿主）。

## 门禁

`pnpm --filter @bim-studio/api typecheck` 通过；严格 tsc（dashboard-acceptance tsconfig，含新 include 4 行）通过；邻居 4 项脚本测试全过；仓库治理门禁通过。

## 下一步

1. 标题合成 z 序专项（缺陷 1，渲染器层）。
2. 采集宿主扩展 value/table 捕获根（缺陷 2，与 P1-18 字形通道合流）。
3. 轴/图例编译进窗口呈现（缺陷 3，P0-01 剩余项）。
