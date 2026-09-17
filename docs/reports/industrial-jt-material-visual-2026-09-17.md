# JT 源材质实景复核与透明度恢复

CoffeeMaker 的源材质已在实际 Studio 中完成两轮复核；修复了场景恢复把半透明外壳改为不透明的问题。本项承接 `04b8730`，不是完整 JT 工程能力验收。

## 输入与复现

- 权威范围：[工业格式计划](../specs/industrial-3d-format-work-plan-2026-09-16.md)。源路径解析与未知状态边界见 [材质路径报告](industrial-jt-material-path-2026-09-17.md)。
- 固定源样本 `voyager-coffee-maker-jt9.5.jt`，SHA-256 `ea7a1ecbba1c1f04fe11049e8537fca8e9bc0f02af354cd01ea8bb9740c46172`。
- 自研转换 GLB SHA-256 `6791ce38cdfb361f938aa1f00845be828ec6c0256dd109bc95cd2182bd2b3e3c`，位于本地 `test-output/jt-material-path-20260917/voyager-coffee-maker-jt9.5.jt/geometry.glb`。
- 当前 Web 独立构建：`pnpm --filter @bim-studio/deep-engine build`，随后 `pnpm --filter @bim-studio/web exec vite build --outDir ../../test-output/jt-current-web-20260917 --emptyOutDir false`。
- 执行 `node apps/web/scripts/gate-jt-material-visual.mjs`。复用仓内隔离 API、登录与真实 Studio viewer，不访问开发业务数据。应用内浏览器发现返回空列表后，使用既有 Playwright Chrome 门禁。

## 两轮截图与缺陷

证据均留在本地 `test-output/codex-2026-09-05/`，未提交模型或截图。

| 轮次 | 目录 | 观察 |
|---|---|---|
| 修复前 | `jt-material-visual-shiOHD` | dark 1920 与 light 1280 实景中，蓝/绿外壳不透明，内部不可见 |
| 修复后 | `jt-material-visual-6Bvecu` | 两个尺寸/主题的完整模型与灰银并排模型共 4 条，外壳恢复半透明，内部可见；每条保存 overview/selected 截图 |

第二轮四条均完成模型选择、属性面板、隐藏/显示，应用错误为零。dark/full 有一条驱动 shader 浮点精度编译 warning，原文保存在 `report.json`，没有并入成功断言忽略的应用错误。

根因是 `setOpacity` 与 `setObjectOpacity` 把源材质 alpha、transparent、depthWrite 全部改为场景值。现在场景透明度作为首次捕获源材质的倍率：默认 100% 保留源 alpha 0.3，50% 得到 0.15，恢复 100% 返回 0.3。WeakMap 保存每个材质基线，共享材质遍历 64 次不累乘；只有透明渲染模式切换才触发材质更新。同族两个 setter 一并修正。后续直接替换或克隆已修改材质的自定义插件策略不在本次证明范围。

## 灰/银共享几何

并排样本选取真实路径中的 `/18/184/` 银色和 `/43/184/` 灰色实例，断言 POSITION 与 indices 是相同 accessor，再改变展示姿态到并排位置；保留材质与源路径。截图证明同一 viewer 可以显示两种源外观，不作为原装配位置证明。原完整模型截图保留装配转换结果。细微灰银差异的数值依据仍是源路径材质报告，不以屏幕像素反推源色。

`missing`/`ambiguous` 的明确状态与中性默认材质策略未改变；没有新增任意材质回退。此次交互验证是模型级选择，不声称截图单独证明全部 occurrence 树逐项点选。

## 视觉自检

使用 design-taste-digitaltwin 的两轮检查与同族排查。对标工作区既定西门子工业信息严谨性、Unity 材质可读性；没有进行外部产品像素级比较。沿用现有令牌、布局、照明和相机，不新增装饰效果。

| 维度 | 本切片自评 | 证据或范围 |
|---|---|---|
| 布局构图 | 9/10 | 两尺寸 fit view 无模型裁切 |
| 令牌一致性 | 9/10 | 双主题沿用既有令牌，无新增 UI 色值 |
| 排版 | 9/10 | 属性面板可读，树长名称沿用截断 |
| 交互状态完备 | 9/10（已测状态） | 空选择、选中、显隐；未覆盖全部异常状态 |
| 动效质量 | 未评分 | 本次未新增动效，不以静态截图证明 reduced-motion |
| 3D 渲染质量 | 9/10（材质切片） | 源透明恢复、灰银共享几何；不评价整个后处理管线 |
| 信息设计 | 9/10 | 模型属性与 100% 场景倍率一致 |
| 反馈即时性 | 未评分 | 交互完成，未测量 100ms 时延 |
| 响应式与主题 | 9/10（桌面） | 实测 1920 深色、1280 浅色；移动端不在范围 |
| 语义与文案 | 9/10 | 既有名称、状态与源路径不变 |

两轮材质视觉回归通过；未覆盖维度不计总分，不据此宣布全产品 Kimi-95 或完整 JT 验收。

## 检查

- 聚焦测试：`sourceMaterialOpacity`、`primitiveMaterial`、`modelInstanceEngine`，3 文件 30 测试通过。
- Web typecheck、当前 Web 构建、repository governance 通过。
- Web 全量测试：598 文件通过、2 跳过；3542 测试通过、2 跳过，78.64 秒。
- 本次不修改几何解析器、X_T 精度预算或工业能力生产门槛。
