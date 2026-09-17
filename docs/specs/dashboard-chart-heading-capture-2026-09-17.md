# Dashboard 图表标题正式采集

服务端构建阶段把已冻结图表的标题、单位测量并交给既有 Native 文本生产器；离线包只携带图集，不新增浏览器、Node 或字体服务器依赖。

## 范围与部署

- 支持 `bar / line / scatter / pie` 的 DOM 标题和单位；复用作者 Widget、typography CSS、节点 padding、背景与文字色。标题显隐继续服从原 `fontSize` 条件。
- `DASHBOARD_NATIVE_DEPLOYMENT_FILE` 的 `configuration.layoutCapture` 可显式配置 `chromiumExecutable`、`playwrightModule` 两个绝对本机路径。配置来自服务启动，不接受 HTTP 客户端选择代码。
- 沿用 `fontCatalog` 为图表节点冻结字体与顺序。仅支持独立静态 OpenType 字体；按 OS/2 实际字重/斜体选择对应面，禁止浏览器合成粗体。TTC、变量字体、缺少对应字重明确拒绝。
- 未配置 host 或没有冻结字体时，标题仍为 deferred。已启用 host 的测量失败、超时、坏字体、取消阻断本次候选，不发布部分图集；旧产物不变。
- `node scripts/build-dashboard-content-compiler.mjs` 同时构建服务端 compiler/deployment 与专用 capture JS/CSS。已有 Playwright Core 依赖可显式选用，不进入离线发行物。

示例配置片段（放入已有 deployment 的 `configuration`）：

```json
{
  "layoutCapture": {
    "chromiumExecutable": "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "playwrightModule": "D:/Documents/bim/bim-studio/apps/cloud-render-worker/node_modules/playwright-core/index.js"
  }
}
```

每次采集限制 4096×4096 与 15 秒，串行、独立浏览器上下文，禁止访问外部网络，结束/取消关闭浏览器和本地服务。冻结候选、数据、字体绑定经已有 `captureDashboardMeasuredLayout`/`verifyDashboardMeasuredLayout` 复核；生成的布局参与编译语义哈希。测量脚本、CSS、浏览器及驱动入口的哈希记入 compiler configuration。

## 本次验证

`scripts/verify-dashboard-chart-heading.mts` 使用固定发布文档和合成两点指标作为输入；C3 冻结、正式构建后的 compiler、Chromium 测量、Native 字体生产器和 Vulkan 窗口均为真实实现。

- 2 张非空图集，实际 regular/bold 字体绑定；重复编译字节完全一致，输入冻结数据未被修改。
- 预取消、途中取消、无粗体、无效字体均拒绝；取消后的再次采集成功。
- RTX 4060 Laptop / Vulkan，1200×800，3 帧，GPU errors clean；Native 报告包含 ChartIR 与两个标题图集的真实 draw layer。
- Native EXE SHA-256：`1a5e9c5d1b37efba199c9a9c79c72aec78e21575554a88abc61259b2dec97f94`。
- Source Sans 3 Regular：`4644c81b86ec9caaa76b634889968ed3c4f4f52f054855933acc7c2b21e53b0f`；Bold：`9214b9d95e4231c609802815c2646c98174e2102d0d37f88978a7f8e71006e6a`。复用本机固定 Adobe Source Sans/OFL-1.1 语料与许可记录，不提交字体字节。
- Web 全量：597 文件通过、2 跳过；3536 项通过、2 跳过。Web/API typecheck、API 布局/closure 25 项、接线 3 项、repository gate 通过。跳过项是原套件项目，不计为本次证据。

复跑环境变量：`C2_NATIVE_EXECUTABLE`、`C2_FONT_PATH`（regular）、`C2_BOLD_FONT_PATH`（bold）；可选 `C2_VERIFY_WINDOW=1`。命令：`pnpm exec tsx scripts/verify-dashboard-chart-heading.mts`。结果保存在本地 `test-output/dashboard-chart-heading/result.json`、`package.json`。设置 `C2_HEADING_PREVIEW_PORT=5327` 可启动同一构建页面供截图检查。

## 视觉复检与边界

对标 FVS 的标题/单位层级，令牌沿用 base.css；原作者默认文字色抽为共享函数，未改色值。第一轮发现旧 host 缺少 typography CSS/节点 padding；第二轮发现浅色主题下 host 默认文字色不同于作者端。两处修复后复检 480px 深色、320px 浅色组件，无裁切/单位重叠，浏览器 error/warn 均为 0。

本地截图：`test-output/dashboard-chart-heading/dark-480.png`、`light-320.png`。

| 视觉维度 | 本片自评 |
|---|---|
| 布局构图 | 9，节点局部坐标和 padding 实测 |
| 令牌一致性 | 9，既有 CSS 与共享作者色 |
| 排版 | 9，真实 regular/bold；缺字重拒绝 |
| 交互状态 | 不适用，本片不新增交互 |
| 动效 | 不适用，动画不作为静态标题证据 |
| 3D 画质 | 不适用 |
| 信息设计 | 9，标题/单位分离 |
| 反馈即时性 | 不适用，沿用候选状态机 |
| 响应式与主题 | 9，固定组件两档/双主题截图 |
| 语义文案 | 9，作者标题/单位原文 |

工程自评十维依次为 9/9/9/9/9/9/9/9/9/9，依据本片失败注入、真实生产器、类型检查及全量 Web 回归。

完整图表外观、标题装饰伪元素、浏览器/Native 整帧像素一致性、中文字体语料、全尺寸页面布局与 HTTP 发布→下载链仍不由本片证明；`appearance.crossHost` 和交互字段保持 deferred。真实 Native 验证证明图集实际绘制和 GPU 提交，不是跨宿主视觉一致性结论。
