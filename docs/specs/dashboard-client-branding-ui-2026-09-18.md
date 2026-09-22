# 离线客户端名称与图标

Dashboard 离线包弹窗新增下载级名称、PNG/ICO 图标和恢复默认；不修改发布文档或全局品牌。Scene 复用 `ClientPackageBrandingFields` 与纯校验 helper，自行说明目标包语义。

## 合同与交互

- 默认 `Deep Monkey Studio` 和产品图标，不发送自定义字段；EXE/ZIP 自定义走原下载地址 POST `{branding}`。Web/DMDA 保持 GET，面板明确它们不包含 Windows 客户端。
- 名称 trim 后最多 80 字符、拒绝控制字符；图标 ≤2 MiB，先检验 PNG/ICO 文件头，不信扩展名。服务端仍负责实际像素解码。读取中有即时状态和禁用，恢复默认/卸载取消迟到结果，并清除 pending。
- `invalid_client_branding` 的 Response 与 SDK rejection 两条路径均显示局部错误、保留 ready 候选及字段，不重新冻结编译。候选过期/失效沿原恢复流程。
- RFC 5987 `filename*=UTF-8''...` 优先于兼容 filename，支持中文下载名；坏编码/路径分隔符/控制字符安全回退。

## 验证

四个聚焦测试文件共 32 项覆盖默认、自定义、仅 EXE/ZIP、取消信号、图标预算/伪扩展名、中文文件名和两类服务端拒绝。Web typecheck 在最终错误恢复修复后再次通过，相关 diff 空白检查通过。

真实浏览器、实际组件、拦截候选 API 的 UI 验收（不替代服务端或 PE 资源验收）：

- `test-output/dashboard-branding-browser-20260918/result.json`：两轮 × 1920/980/480 × 深浅主题，12/12。实际点选/上传/下载、默认 GET、自定义 POST、Web/DMDA GET、恢复默认、键盘 Tab 与 Escape、无页面异常。
- 追加真实 SDK 400 反例首轮发现错误进入 failed；补 SDK rejection 分支后，`test-output/dashboard-branding-rejection-browser-20260918-r2/result.json` 的两轮 480px 深浅主题 4/4。保留同一候选、字段可编辑、直接重试下载成功；首轮失败截图保留。
- 视觉复核还发现主按钮 hover 被通用 soft 背景覆盖、黑字对比不足，局部修为 accent-hover。共享字段 CSS 已独立，Scene 不依赖 Dashboard 样式加载。

## 设计验收

对标工作区西门子 PS/PD/Plant 的克制工程表单：沿原弹窗栅格，不新增装饰卡片；全部色彩与控件圆角使用 `base.css` 令牌，无新增色值。依据首轮 980 深色、第二轮 480 浅色及错误态两轮原截图复核。

| 维度 | 本片评分/边界 |
| --- | --- |
| 布局构图 | 9：字段、预览、动作对齐；480px 无横向溢出 |
| 令牌一致性 | 9：深浅主题及品牌 accent 同源 |
| 排版 | 9：名称/说明层级明确，无意外截断 |
| 交互状态 | 9：读取、禁用、错误、成功、focus、恢复默认均有实际操作 |
| 动效 | 不适用：不新增动效，原弹窗行为保留 |
| 3D | 不适用：本片是二维表单 |
| 信息设计 | 9：只放名称与图标，格式适用范围紧邻字段 |
| 反馈 | 9：即时读取与下载状态；服务器图标错误可直接修正 |
| 响应式/主题 | 9：1920/980/480 双主题，两轮 |
| 语义/文案 | 9：仅下载级配置，Web/DMDA 与 Windows 客户端范围明确 |

这是弹窗切片的视觉验收，不关闭 Deep2D 项目级 V-02。实际自定义 EXE/ZIP 的下载、图标资源和窗口名称由服务端/Native 同批证据确认。
