# Web 静态包浏览器验证与 loader 取消竞态修复（2026-09-17）

## 范围

接手 [codex-mainline-handoff-2026-09-17.md](../codex-mainline-handoff-2026-09-17.md) 阶段 1 剩余项：

1. 修复 `dashboardWebPackageLoader` 最后 EOF 取消竞态（交接清单第 3 条红测试）。
2. 补包根路径纵深防御。
3. 对在途代理产出的静态包（`test-output/dashboard-web-static-20260917-r5.web.zip`）做两轮真实浏览器验证闭环。

## 代码改动（b3b6bc3）

- `apps/web/src/delivery/dashboardWebPackageLoader.ts`：
  - 流读取 `done` 分支先 `signal.throwIfAborted()` 再返回——EOF 与取消同时到达时以取消为准，禁止已取消后仍发布"完整包"。
  - 新增 `resolvePackagedUrl`：manifest 校验（`dashboardWebPath` 已拒绝 `..`/绝对路径/空段）之后按解析结果二次校验 origin 与前缀，任何请求必须落在包根内；包根地址必须以 `/` 结尾，否则在任何请求前 fail-closed。
- 测试 5→6 项全部通过；`pnpm --filter @bim-studio/web typecheck` 通过。

## 浏览器验证矩阵（两轮，15/15 通过）

环境：Windows 10.0.22621、Chrome（`BIM_STUDIO_CHROME_PATH` 默认路径）、Playwright chromium 驱动、随机端口本地静态服务（严格映射、404 fail-closed）。
脚本与证据：`test-output/verify-web-static-20260917.mjs`、`test-output/web-static-verify-r5/`（`result.json` + 31 张截图）。

| 场景 | 结果 | 证据 |
|---|---|---|
| 根目录冷启动（深色） | 两轮通过，~1.6 s | round{1,2}-root-dark.png |
| 浅色主题 `?theme=light` | 两轮通过；宿主 chrome 变浅，画布外观由作者冻结数据决定 | round{1,2}-root-light.png |
| 子目录服务 `/nested/deep/` | 两轮通过（相对路径资源闭包成立） | round{1,2}-subdir-dark.png |
| 980×680 窄屏 | 两轮通过，等比自适应无溢出 | round{1,2}-narrow-980.png |
| 浏览器全屏按钮 | 两轮通过，`fullscreenElement` 建立、按钮转"退出全屏" | round{1,2}-fullscreen.png |
| 篡改字体字节 | 两轮拒绝，错误态精确指出 `resources/heading-700-…` 校验失败 | round{1,2}-tampered-rejected.png |
| 删除字体资源 | 两轮拒绝（HTTP 404 fail-closed） | round{1,2}-missing-rejected.png |
| 取消恢复（pagehide abort 后重开） | 通过，重新校验并完整渲染 | round1-cancel-recover.png |

截图人工复核：标题自定义 700 字重字体、坐标轴刻度、MW 单位、双柱图、深浅主题、窄屏适配、错误态均正常；十维自评均 ≥9。

## 未验证 / 边界

- 静态包**生成端**（runtime package → web.zip）仍是并行会话在途工作，本片只验证了其 r5 产物；生成端收拢与 API 下载格式注册未关闭。
- 浏览器仅 Chrome（Playwright chromium 内核）；Firefox/Safari 未测。
- 取消恢复验证的是 `pagehide` 导航语义，不覆盖下载中途断网字节流（该路径由 loader 单测覆盖）。
- r5 产物由修复前的生成器产出；loader 修复只影响浏览器端校验行为，产物无需重打。

## 下一步

1. 收拢静态包生成端（复用 ScenePublication 资源闭包，不建第二套发布状态机）。
2. API 注册 web 下载格式并做生产构建门禁。
3. 继续 Deep2D P0 收拢（P0-01/03/04/05/06/07/08）。
