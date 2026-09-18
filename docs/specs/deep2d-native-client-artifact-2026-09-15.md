# Native 客户端编译产物

`exportSceneClientPackage` 的 Deep Native 路径已调用真实场景编译器。ZIP 生成成功表示构建产物已下载；是否具备发布条件由能力报告决定。

## ZIP 内容

| 路径 | 内容 |
| --- | --- |
| native/runtime-package.json | Native 可解析的 v3 运行包，含当前已编译的静态场景与相机 |
| native/compilation-evidence.json | 源/编译/产物哈希、资源映射、已编译与未编译字段 |
| native/compatibility-report.json | 对象及相机能力报告；缺少运行证据仍为 blocked |
| manifest.json | 运行包路径、版本、包哈希、报告状态及逐文件SHA-256 |

原有 scene/applications/project/runtime JSON 和资源继续保留。`runtime.json` 是脱敏的数据配置，不是 Native 渲染运行包。`conversionRequired` 占位字段已移除；Native capabilities 不再固定宣称二维/三维/绑定全部支持。

## 构建行为

场景在首次异步操作前取得快照。GLB 编译复用已下载的资源字节，不重复联网。PNG/JPEG 解码器从 lab 提升为共享浏览器宿主适配器，lab 与正式打包复用同一实现。结构或不支持的外观编译失败会使打包失败；取消后不会下载迟到的ZIP。

普通名称、ID、枚举及脚本文本不再被当作URL改写。URL字段继续脱敏，原始签名地址仍能正确匹配包内资源路径。

浏览器解码器通过 `@bim-studio/deep-engine/browser-image-decoder` 独立入口加载，避免打包初始化同时求值完整 WebGPU 渲染模块。导出集成测试保留真实编译器和默认超时。

导出测试使用真实 JSZip 生成下载 Blob，再解压并检查 CRC、每个索引文件的大小和 SHA-256、原始 Box.glb 字节、运行包内部哈希及证据中的产物哈希。编译模块在测试收集阶段加载，避免 Vitest 转换排队占用单例执行时限；每项结束取消并等待未完成导出，避免迟到结果污染后续用例。

Native 启动器当前接收运行包 JSON。解压后在包目录执行 `deep-engine-native.exe --headless-package "native/runtime-package.json"` 校验，窗口加载使用 `--package`。ZIP 本身不是启动器输入，启动器也不包含在此源码产物中。

## 当前边界

正式发布硬阻断仍需控制器消费能力报告。当前打包入口未提供受信任的Native窗口证据，报告因此保持blocked；下载产物不代表Native发布ready。二维、环境、行为、完整导航等能力继续按编译器未消费字段记录，P0整体尚未完成。

资源/应用来自打包时读取的项目版本，未承诺整个依赖图都冻结于场景发布时刻。包版本和资源revision的增量策略仍待P1接入。
