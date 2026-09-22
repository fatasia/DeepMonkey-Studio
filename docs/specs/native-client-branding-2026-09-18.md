# Native 客户端品牌资源与发布覆盖

默认使用现有 Deep Monkey Studio 品牌；发布时可覆盖客户端名称和 PNG/ICO。未指定的字段沿用默认，名称与图标不依赖运行目录或 EXE 文件名。

## 实现

- `build.rs` 通过现有 Windows SDK `rc.exe` 嵌入 Tauri 唯一 `icon.ico`，SDK 支持注册表非默认安装路径。默认 VERSIONINFO 为 Deep Monkey Studio / 0.1.0.0；无新增依赖。
- Native 使用资源组 101 设置标题栏与任务栏；RCDATA 102 保存发布级 UTF-8 名称。窗口所有后续状态标题共用这一名称。
- API 在核对原 EXE SHA 后，向临时副本更新 ICON/GROUP、名称和 VERSIONINFO，再追加 DMDA 或生成 ZIP。同 ID 旧语言资源先删除，再写 neutral，避免系统继续显示旧名称/图标；原候选文件不修改。
- 复用既有品牌门禁并纳入 Native；发布级字段沿用 `ClientPackageBranding`，未建立平行品牌存储。

## 验证

API 品牌资源、单文件和 ZIP 聚焦 12 项通过，API typecheck 通过；Native window_chrome 2 项通过；默认品牌门禁通过。真实 Windows 回读 ProductName/FileDescription、0.1.0.0 版本、RCDATA 与全部 ICON/GROUP 字节，原 EXE 哈希保持不变。校验包含坏目录、过长/控制字符名称、取消和禁止对已有 overlay 更新资源。

`test-output/native-client-branding-20260918/` 保存默认/中文自定义两轮真实单文件 EXE **无参数启动**、完整发布资源闭包、capability、runtime package 与证据。旧 2x 候选未落 freeze，且数据冻结含时间；本次从同一正式发布源取得一次新候选，未改写旧候选身份。

- 默认标题：`Deep Monkey Studio | F11 全屏`；自定义标题：`工厂运营中心·验证版 | F11 全屏`。
- 客户区 1200×800、DPI 120；4 张终版内容采样均 41 色。其客户区 3,840,000 个 RGBA 字节完全相同，仅标题/图标变化。早期截图不计验收。
- `WM_GETICON` 实际取得 40×40 窗口图标和 256×256 任务栏图标，各轮 PNG 与 `.brand.json` 留档。自定义输入复用既有横向字标，contain 保留比例；这不是建议的方形图标设计。
- 单文件 footer 与 runtime SHA 一致，ZIP 清单指向品牌更新后的 EXE SHA，原基底 SHA 保持 `6be390c7c4a3dce57ff09ba03a325a49e245319a82f4547a7b830ef1984e813f`。包内 runtime SHA 为 `bceab460bd3526c79bccf0929b8753860dada34792a4b030d5814742719f0308`。
- 证据为真实发布源、函数级包装与实窗；HTTP POST 权限/候选复核由主线程路由测试覆盖，不把它写成浏览器全链路已验收。

截图脚本增加内容颜色门禁；PrintWindow 无内容时仅允许前台目标窗口的 compositor 截图，否则失败，不能只凭 presented 日志通过。

## 视觉复核范围

使用 design-taste-digitaltwin，取西门子式身份一致、克制表达，直接沿用现有品牌，不新增颜色令牌。评分只覆盖本次窗口品牌区域，不重新认证既有 Dashboard 内容。

| 维度 | 结果 |
| --- | --- |
| 布局构图 | 9：图标与标题未遮挡系统按钮 |
| 令牌一致性 | 10：唯一默认品牌资源，无新色值 |
| 排版 | 9：中文/英文名称与系统栏正常显示 |
| 交互状态 | 9：活动/非活动窗口仍保持身份 |
| 动效质量 | 不适用，未新增动效 |
| 3D 渲染 | 不适用，未改渲染 |
| 信息设计 | 9：名称与状态分离 |
| 反馈即时性 | 不适用，启动同步载入本地资源 |
| 响应式与主题 | 9：本机 125% 系统栏及两轮实窗；非多系统主题认证 |
| 语义与文案 | 9：默认名与自定义名、文件属性一致 |

最后的 `clean_name` 修正允许用户显式命名 `deep-engine-native`，2 项单测已验证；上述基底生成于该一行修正前，最终汇总构建须纳入它。签名应位于资源更新之后；跨平台打包宿主不在此 Windows 适配的验证范围。
