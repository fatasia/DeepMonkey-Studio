# 场景客户端包完整性

客户端 ZIP 的 `manifest.json` 索引所有实际负载文件，包含场景、应用、项目配置、数据运行配置、README、资源和 Native 文件。manifest 不索引自身；ZIP 自动生成的目录项不属于负载文件。

## 文件与内容身份

每项包含相对路径、实际字节数、SHA-256 和脱敏来源。文本以 UTF-8 编码计算；二进制按原始字节计算。索引按路径固定排序。

`contentHash` 为 `{ algorithm: "sha256", value }`。其输入使用 Deep Engine 的 canonical JSON 哈希：

```text
{
  metadata: manifest 去掉 generatedAt、files、contentHash,
  files: 按路径排序的 [{ path, bytes, sha256 }]
}
```

构建时间、ZIP 时间和索引中的 sourceUrl 不参与内容身份。目标、renderer、工具栏、项目/场景身份、发布状态和全部负载字节参与身份。修改 payload 或交付配置会改变哈希；只改变生成时间不会改变它。

这项哈希用于完整性比对，不是签名或运行能力证据。校验方必须先检查文件集合、大小和逐文件哈希，再检查内容哈希；只比较 manifest 内声明的字符串不构成校验。

## 路径规则

准备阶段和最终索引使用同一套路径检查，拒绝绝对路径、反斜杠、盘符、空段、点段、控制字符及 Windows 非法文件名。大小写冲突、文件与目录前缀冲突、manifest.json 及其子路径均拒绝，防止 ZIP 或解压器覆盖已有内容。中文及正常内部空格保留。

## 读取校验命令

仓库依赖安装、Deep Engine 构建完成后，用 Node 24 运行：

```powershell
pnpm verify:scene-client "D:/exports/scene.three-webview.bimscene.zip" --target three-webview
pnpm test:scene-client
```

`--target` 必填，也可指定 `deep-native`。成功输出 `integrity-verified`、内容 hash、文件数及总负载字节；失败退出码为 1。命令只读取 ZIP，不提取文件或启动播放器。诊断包、旧清单、未知 renderer/target 和目标不匹配直接拒绝；Native 清单要求 schema 3 与 ready 状态。

读取器复用 [yauzl](https://github.com/thejoshwolfe/yauzl) 3.4.0，逐条读取中央目录，检查重复路径、本地/中央文件头一致性和重叠区间。目录必须为空且对应实际负载的父目录，符号链接及其他特殊文件拒绝。逐文件流式计算大小、CRC 和 SHA-256，实际文件集合必须与清单一致。

默认限制为 ZIP 512 MiB、清单 1 MiB、单文件 256 MiB、累计解压字节 1 GiB、条目 10,000。读取器 API 允许调用方显式配置限额，CLI 使用默认值；STORE、DEFLATE 和普通流式 data descriptor 均覆盖真实文件测试。ZIP64 data descriptor 明确拒绝，超过限额的包不属于当前命令支持范围。

## 验证与后续

真实 JSZip 解压测试检查负载集合与索引一一对应，包括此前未索引的五类文本。场景、runtime 和 README 的单字节改动均导致逐文件哈希和重算内容哈希不匹配；不同构建时间保持内容身份稳定，runtime 或 renderer 变化使身份变化。Native 诊断 ZIP 的真实编译、CRC、内包及资源字节验证继续保留。

真实 exporter 输出已交给独立 Node CLI 验证。Node 测试覆盖缺失/额外负载、单字节变更、CRC、重复条目、路径冲突、危险目录、符号链接、伪造尺寸、限额和取消。

Native 目标还通过引擎现有 `parseDeepRuntimePackage` 验证内包资源与内容 hash，并核对外包身份、场景语义 hash、运行包实际字节 hash、编译记录和兼容报告。编译 recipe、相机映射、能力配置、Windows 平台及样本身份必须匹配；未编译字段、缺失检查项和不匹配的运行证据拒绝。普通 Native 元数据单文件另限 64 MiB，运行包保留 256 MiB 上限。

`integrity-verified` 表示包内内容及证据引用一致，不证明窗口证据来源可信或本机 Native 已成功运行。v4 记录完整预算、局部坐标帧和相机/packet hash，CLI 独立重算 compileGraphHash；保留的 v3 兼容读取仅检查记录间身份。本页下述启动命令强制执行校验；完整后端/feature flags 门禁仍需后续验收。历史依赖冻结状态见当前开发总账。


## 已验证 Native 包启动

安装仓库依赖并完成 Deep Engine 构建后，用现有 Native 可执行文件打开正式包：

```powershell
pnpm run:scene-native "D:/exports/scene.deep-native.bimscene.zip" --native-executable "D:/native/deep-engine-native.exe"
```

该命令先执行上述全部 `deep-native` 完整性检查，拒绝 diagnostic 包。随后从同一次读取的内存字节中，仅提取 `native/runtime-package.json`，再次核对大小及 SHA-256，以固定文件名写入独立临时目录，再调用指定程序的 `--package` 入口；不会重新读取源 ZIP，也不解压其他条目。等待客户端退出后清理临时目录，启动失败或非零退出同样清理并返回失败。

启动器不生成 EXE。显式添加 `--verify-window` 时，复用完全相同的 ZIP 校验与运行包提取路径，然后调用共用窗口验证器，固定运行 3 帧后退出并输出本机证据；普通模式保持 `--package`。检查模式复制实际 EXE 与运行包，核对 nonce、字节 hash、尺寸、呈现帧及 GPU 状态，不接受 CLI 指定报告、nonce 或帧数。操作系统强制终止启动器时，临时目录清理不作保证。

```powershell
pnpm run:scene-native "D:/exports/scene.deep-native.bimscene.zip" --native-executable "D:/native/deep-engine-native.exe" --verify-window
```

launcher 与共用窗口验证器 33 项测试通过，包括篡改 ZIP/运行包、错误报告身份、GPU/帧数失败、进程退出和清理。真实独立 HTTP→服务端候选→Web ZIP→CLI→同 ZIP 离线窗口已通过，详见[窗口证据](scene-native-publication-evidence-2026-09-15.md#独立-http-到正式-zip同包离线窗口)。样本为十亿场景单位偏移 box，离线窗口 Vulkan 1200×800、3 帧、GPU clean。该验证使用独立 JsonStore/LocalObjectStore 和 Web 导出函数，不代表实际 Postgres/MinIO 浏览器下载链已验收；两次窗口 EXE SHA 不同，原始记录分别保留。
