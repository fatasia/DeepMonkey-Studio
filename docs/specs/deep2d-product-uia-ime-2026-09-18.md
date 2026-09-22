# Deep2D 产品窗口 UIA 与注释输入事务

状态：已完成本切片。普通 winit 窗口现发布真实图表语义；注释输入复用 `ImeSession`，不新增依赖。

## 产品路径

- `app/lifecycle.rs::resumed` 将 UIA provider 挂到实际窗口 HWND；`about_to_wait` 比较活动语义树，仅变化时发布。桥持有窗口引用，先 detach 再释放 HWND。
- 图例树与键盘入口共享 `LegendSnapshot`，读取实际名称、当前分页、hidden 状态。隐藏图例不发布空导航组；普通图表有中文系列摘要；包版本变化更新根属性，切到无图表包移除旧节点。
- `WindowEvent::Ime` 与 `WindowEvent::Focused` 进入注释编辑事务。preedit 不改 draft，Commit 一次落入共享文档，Backspace 按完整字素簇删除，失焦取消组合并拒绝迟到提交，重新聚焦后继续输入，退出编辑清空事务。
- 256 Unicode 标量持久化上限保持；超限截断按完整字素簇，避免截断组合符或 ZWJ emoji。`Ime::Disabled` 只取消组合，不取消键盘焦点，切回英文键盘仍可输入。
- DPI 补查：winit 0.30.13 Windows 实现只在 `set_ime_cursor_area` 调用时将逻辑值转成物理值，原入口只在 `Ime::Enabled` 设置一次。现于开始编辑、重新聚焦、resize、ScaleFactorChanged 重新提交物理锚点，使用新 scale payload，避免重复缩放；64×64/1×1 小窗夹取，零尺寸不提交。两项纯逻辑测试覆盖 DPI 1/1.25/1.5/2/3、极小窗及非法 scale。注释仍显示在标题栏，此处是固定 client-area 候选锚点，不是富文本像素 caret。

## 已核对的旧状态

原报告称“未接产品事件循环”过宽：`app/annotations.rs` 已消费 IME，但直接改 String、使用码点 `pop()` 且没有失焦取消。本片补这些实际缺陷。cosmic-text 0.19 与 bidi/fallback/shaping 已在依赖树中；`rtl_and_mixed_chinese_runs_use_only_explicit_frozen_faces` 已验证冻结 Hebrew/中文混排、布局及重复像素一致，本轮 Native lib 复跑通过，无需引入另一 shaping 库。

## 验证

- 真实 RTX 4060 Laptop / Vulkan winit 窗口：生产 resumed 挂桥，MTA CUIAutomation 客户端枚举 chart/legend，生产 ToggleLegend 后读到 hidden，包替换后旧图例消失，detach 后 provider 移除。
- 同一真实窗口通过生产 WindowEvent 入口验证 composition→中文/组合符/ZWJ Commit→整簇退格→blur→迟到 Commit 拒绝→refocus→Hebrew 追加→Esc 取消。属于程序驱动宿主轨迹，不是人工操作 Windows 输入法候选窗。
- 输入纯逻辑 4 项覆盖原子提交、undo/redo、整簇退格、失焦恢复、预算、超长 preedit 和 IME 禁用后 ASCII 输入。
- 最终 Native lib 362 通过/1 显式忽略，bin 136 通过/51 显式忽略（含 IME Disabled 回归）。clippy all-target/all-feature `-D warnings`、fmt 通过。UIA/IME 窗口用例已单独显式运行，日志 `test-output/deep2d-codex-uia-ime-host-20260918.log`；完整 CPU 日志 `test-output/deep2d-codex-native-final-20260918.log`。

## 保留边界

UIA 此片是图表/图例只读语义，不声称 Invoke/Value Control Pattern、准确 BoundingRectangle、Narrator 真人朗读或完整 Dashboard 语义树。DPI 数学与宿主更新接线已有测试，真实 Windows IME 候选窗的跨屏目检和富文本选择/光标仍按原任务表验收。

设计基准沿用 `design-taste-digitaltwin` 的西门子式状态一致性与既有 `base.css` 令牌；未改变画面样式、布局或色值。10 维视觉自评未评分：本片证据是状态与系统语义，无两轮浏览器截图，不能计作 V-02/Kimi-95 视觉验收。交互状态及反馈以以上实际路径断言为证；其余视觉维度由主线统一验收。
