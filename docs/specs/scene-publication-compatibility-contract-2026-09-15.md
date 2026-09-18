# 场景发布兼容报告

此合同供场景检查器、编译器和发布控制器共享判断结果，入口为 `@bim-studio/contracts` 的 `summarizeScenePublicationCompatibility`。

## 输入与证据

- 每项记录场景、对象、字段路径、能力 ID、状态、原因、替代路径和证据 ID。
- 内容身份复用编译器的 `sourceSemanticHash`；报告同时绑定 `compileGraphHash` 与 `targetArtifactHash`。
- 编译器与检查器共用 `sceneCompilationSource`：仅排除顶层 updatedAt/publishedAt，recipe 为 deep-scene-static-compile-v3。发布更新时间不会单独改变编译身份；名称、相机、未知元数据、嵌套时间字段均保留。历史定位指纹和服务端 CAS 仍比较完整快照，旧 recipe 证据需重新编译。
- 证据包含目标、能力、三种 hash、样本、平台及验证范围。更换内容、编译配置、产物或样本后，旧证据不能复用。
- 能力配置只定义已知能力名称。未知能力、缺少证据、重复检查或证据绑定不匹配均阻断。

`static-render-packet` 表示静态编译证据。Deep Native 的支持或降级项要求匹配 `native-window`、`windows-x64` 证据；Three WebView 要求 `web-runtime` 证据。样本验证仅适用于报告指定的样本与产物。

## 输出

`blocked` 阻断发布；`confirmation-required` 要求用户确认具体降级；`ready` 表示提交给汇总器的检查项通过。Native 遇到 `webview-only` 时阻断。

调用方必须遍历全部待发布能力，并验证证据来源。汇总器只校验绑定和决策规则，不验证证据文件真实性，也不能发现调用方漏交的检查项。

## 接入状态

公共合同与汇总器已实现。Web 的 `delivery/scenePublicationCompatibility.ts` 提供 `assessCompiledScenePublication`：消费真实编译证据，比较保存快照 hash，检查作者/绘制对象映射，并将 deferred 字段保留为对象级阻断。静态编译不能替代 Native 窗口证据；二维只消费编译器返回的未编译字段。

适配器使用基础体与真实 Box.glb 编译输出验证，当前 10 项通过。`compiledSceneFields` 中的相机映射必须为 `camera / deep.scene.camera.v1 / scene.camera`，并独立匹配 Native 窗口证据。未知或重复资源映射、与 deferred 矛盾、相机从两份清单同时消失均阻断；几何证据不能放行相机。

正式导出入口已在 ZIP 创建和下载前调用 `assertScenePublicationDeliverable`。检查器报告的上下文和证据绑定由现有汇总器重新核验；顶层 ready 不能掩盖 blocked、未确认降级或 Native 的 webview-only。错误保留具体对象、字段、原因和替代路径；界面正文限制为前 8 项，完整报告保存在错误对象中。

`exportSceneClientDiagnosticPackage` 是独立研发接口，只接受 Deep Native；诊断文件名含 `.diagnostic`，manifest 的 purpose 为 diagnostic，返回 diagnosticFileName 而非正式交付结果的 fileName。正常发布任务和重试不调用此接口。诊断包仍保留真实运行包、编译证据及 blocked 报告，供编译与 ZIP 完整性验证。

Native 发布已在 configured 保存和引用检查之后调用 `prepareSceneClientPackage`，兼容检查通过后才调用 publish。准备阶段不生成 ZIP；失败保留弹窗且不创建发布版本。Three WebView 保持既有发布路径。保存快照的引用健康检查及原子发布见 [快照一致性记录](scene-publication-snapshot-consistency-2026-09-15.md)。

准备结果是模块内 WeakMap 登记的一次性句柄：只在当前页面内有效，不克隆、不持久化。首次任务经 App hook 和 runner 原样传递给 exporter；交付前重新核对项目、场景、目标、renderer、工具栏及编译源身份，内容变化或重复消费拒绝。发布的两个时间字段写入最终 scene.json 和 manifest，已读取的资源字节与 Native 编译结果复用。准备和交付的取消信号均有效。

正常重试不保留句柄，重新读取原发布历史并准备；资源与应用目前仍来自当次准备时的项目读取。本次只冻结准备到首次交付之间的字节，不等于已完成随发布版本冻结全部依赖的 D06。

当前没有可信 Native 窗口证据提供方，因此正式 Native 预检会阻断。单次真实编译与 ZIP 复用的成功分支使用明确标注的测试窗口证据替身；完整能力覆盖、真实运行证据及降级确认仍待完成，D02/D03 保持本轮待办。
