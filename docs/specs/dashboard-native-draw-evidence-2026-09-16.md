# Dashboard Native 绘制证据

`--verify-package` 的正常窗口回执新增设备身份和实际 Deep2D 绘制层，供 Dashboard 发布能力报告使用。

- composite 准备保留每个 chunk 的来源层；GPU painter 仅在通过 scissor 检查并发出非空 `pass.draw` 后累计该层的 draw calls、顶点数及实际绑定 atlas。空层和没有绘制的资源不构成证据。
- 仅验证窗口启用计数。回执在成功 `Presented`、GPU scopes/callbacks 清洁且规定帧数完成后写出；设备变化拒绝。设备指纹使用 Runtime Package canonical hash，对象包含适配器名称、backend、vendor/device、driver 及 PCI 身份。
- `createDashboardNativeWindowVerifier` 复用注入的真实 Native 进程验证器，私有暂存精确 artifact，结束时清理。绑定器验证 artifact hash、包身份、窗口成功、设备及可信 compiler 的 node/font binding。字体必须属于冻结资源，并对应实际发出的 atlas draw；未使用字体不补写。

## 验证证据

真实 `producer.package.json`（C2 ae22419 rerun）在 RTX 4060 Laptop / Vulkan / driver 595.79 上通过 1200×800 正常窗口 3 帧；16 层发出绘制、对应 15 个节点及 12 个 atlas，GPU scopes 与 callbacks 清洁。回执 package hash 为 `7781a46ca0e93066460cc33666aabf987ea117fd3bc86c622004f058c9ff40a8`，设备指纹为 `32b36c31fa3dad1ad8c9beea224fcd27ce6e580587df9aa39e701d1d01dfa5b4`。

聚焦回归包括绘制计数、组合层归属、Native 报告生命周期，以及 JS 逐节点/字体绑定、设备与产物替换拒绝、进程失败和取消清理。实际绘制记录表示提交并成功呈现了这些绘制命令，不代表每个像素可见或未被其它对象遮挡；交互、视觉质量、多页逐页窗口覆盖仍按原 C1/C5 验收。

只有 entry page 的实际绘制会进入本回执，未呈现页不会被标为已验证。API 的字体策略还需区分完整冻结闭包与实际使用子集；不得为满足完整闭包比较而补入未使用字体。
