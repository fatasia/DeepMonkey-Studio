# Parasolid x_t/x_b 可落地接入方案

## 结论

M5 选择 **CAD Exchanger Batch 单服务器私有部署** 作为第一落地路径：唯一服务器持有许可证和转换执行程序，B/S 与 Tauri 客户端都把源文件上传到同一服务器，由隔离 Worker 执行 x_t/x_b → GLB。这样最符合当前“只有一个服务器、IP/端口可变化、账户系统一套”的部署现实，也避免在每台 Tauri 客户端支付和管理原生 SDK 分发许可。

当产品需要比 GLB 更完整的装配属性、稳定实体标识或定制三角化时，再把同一个 Provider 升级为 CAD Exchanger SDK sidecar。HOOPS Exchange 和 Datakit CrossCad/Ware 保留为可替换供应商，不让编辑器核心依赖某一家 SDK。

当前机器没有可合法直接接入的免费 Parasolid 转换器。扫描发现：

- `C:\Program Files\Common Files\Autodesk Shared\Components\2026\1.3.0` 含 `pskernel.dll` 和 Autodesk ATF Parasolid bridge，但它们是 Autodesk 产品私有运行时；没有独立 SDK、CLI、授权或再分发证明，**不能拿来动态调用或随包发布**。
- `D:\Documents\ChatGPT\IoT` 旧实现只有 x_t 文件头检查、同名 GLB 旁车和 `IOT_NB_XT_ADAPTER` 槽位；没有 x_t/x_b 三角化实现。
- 当前 `occt-import-js` 只承担 STEP/STP。OCCT 开源数据交换模块列出的原生工具包包含 STEP、IGES、glTF 等；Parasolid 属于另外购买的 Advanced Data Exchange 组件，不能把 OpenCascade 描述成免费原生支持 x_t/x_b。

## 厂商路径比较

| 路径 | x_t/x_b | 私有部署 | 接入成本 | 许可边界 | 决策 |
| --- | --- | --- | --- | --- | --- |
| CAD Exchanger Batch | 可直接转 GLB | Windows/Linux/macOS 服务器 | 最低，CLI Worker | 按服务器/MAC；CLI 不面向客户端再分发 | **M5 首选** |
| CAD Exchanger SDK | 读写 Parasolid、glTF，统一模型树 API | 服务器、Docker、桌面 | 中等，需 C++/C#/Java/Python sidecar | 开发费 + 分发费；桌面/服务器机器计费不同 | 需要结构化属性时升级 |
| HOOPS Exchange | x_t/x_b 至 Parasolid 38.1；装配、B-Rep、三角网格 | 原生 SDK sidecar | 中高 | 商业 SDK 与分发许可 | 第二供应商 |
| Datakit CrossCad/Ware | 声明支持 x_t/x_b/xmt | 原生 SDK sidecar | 中高 | 商业合同，报价/版本范围需采购确认 | 第三供应商 |
| Siemens Parasolid Kernel | 原生 XT 与建模内核 | 原生 SDK | 最高 | 内核开发/分发合同 | 只有要做 CAD 建模内核时考虑 |
| OCCT / FreeCAD 免费包 | **无免费原生 Parasolid reader** | — | — | OCCT 的 Parasolid 插件为商业组件 | 不作为 x_t 解析器 |

CAD Exchanger 官方资料明确说明：SDK 可完全私有或云内部署、无需联网，支持 Docker；Batch 是轻量服务器 CLI，许可证绑定特定服务器 MAC，不能当作普通 Tauri 附件分发。其 Parasolid 页面明确列出 x_t/x_b 到 glTF/GLB。SDK 分发权与开发权分别计费，采购合同必须覆盖实际服务器和未来桌面分发方式。

## 当前 Provider 探针

API 已默认选择 `cadexchanger-batch`，但在许可和程序未安装前保持 `available: false`。`GET /api/converters` 会返回具体 Provider、探针状态、命令和修复建议，不再只有泛化“等待转换器”。

环境变量：

```text
PARASOLID_CONVERTER_PROVIDER=cadexchanger-batch
PARASOLID_CONVERTER_DEPLOYMENT=server
PARASOLID_CONVERTER_COMMAND=C:\BimStudio\converters\bim-studio-parasolid-adapter.exe
PARASOLID_CONVERTER_PROBE_ARGS=["--probe","--json"]
```

adapter 内部的正式 Batch 程序名与参数必须以购买后随安装包提供的文档为准；项目不猜测未公开 CLI 语法。可选 Provider 值为 `cadexchanger-batch`、`hoops-exchange`、`datakit-crosscad`。探针状态：

- `not_configured`：已选 Provider，未配置命令。
- `not_found`：命令路径或 PATH 不正确。
- `probe_failed`：程序启动失败、许可证不可用或探针返回非零。
- `detected`：可执行程序和版本可探测；仍需完成转换执行器绑定后才把插件标为可用。

## Server Worker 与 Tauri 边界

```text
Browser / Tauri
  -> 上传原始 x_t/x_b 到 MinIO
  -> POST conversion-task
  -> API 队列
  -> 隔离 Server Worker
  -> 已授权 Parasolid Provider
  -> GLB + hierarchy.json + properties.json
  -> 校验并写回 MinIO
```

Server Worker 流程：

1. 以任务 ID 创建独立临时目录，只下载任务声明的 MinIO 对象。
2. 读取前 64 KiB 做低成本预检，但不把预检当作真正解析成功。
3. 启动无 shell 的签名 sidecar，限制超时、内存、CPU、输入和输出目录；取消时终止进程树。
4. 优先执行 x_t/x_b → GLB 直接路径；读取 SDK 模型树另写 `hierarchy.json`、`properties.json`。
5. 验证 GLB 2.0、非空网格、有限坐标、包围盒、索引范围、层级引用和输出总量。
6. 原子写入 MinIO，记录输入 SHA-256、Provider 版本、配置哈希和产物哈希；失败时清理临时产物但保留源文件。

Tauri 默认不本地转换，只复用服务器任务 API，因此服务器 IP/端口改变不影响工程格式。若未来客户购买桌面分发许可，可提供同协议的 Windows sidecar；Tauri 只负责路径授权、进程启动和进度转发，不把 CAD SDK 链进 WebView 或 Rust 核心。

建议的供应商无关 sidecar 协议：

```text
bim-studio-parasolid-adapter --probe --json
bim-studio-parasolid-adapter convert --request <job.json> --result <result.json>
```

`job.json` 只含绝对输入/输出路径、任务 ID、弦高/角度公差、单位策略、坐标策略和取消句柄；`result.json` 返回 Provider/版本、检测到的 Parasolid 版本、装配树、属性产物、网格统计、警告与结构化失败码。任何网络访问默认关闭。

## x_t/x_b 版本探测

x_t 是文本传输，x_b 是二进制传输。预检器扫描文件头中的 `PARASOLID` 和 `SCH_<digits>`；例如官方资料中的 `SCH_12006` 可推断主版本 12，`SCH_35006` 可推断主版本 35。该规则只用于快速提示与路由：

- x_t：可报告 schema ID 和“推测主版本”。
- x_b：若文件头暴露 schema token 则报告，否则显示 `unknown`。
- 最终支持判断必须来自 Provider 实际 import 结果和其版本矩阵，不能仅凭扩展名或 schema 字符串。
- 文件内容和扩展名冲突时返回警告并由 Provider 强制识别；不自动重命名源文件。

## 直接 GLB 与 STEP 中间路径

默认使用 **x_t/x_b → Provider 模型 → GLB**：少一次 B-Rep 翻译，可保留实例、颜色、装配变换和 Provider 暴露的用户属性，并能统一控制三角化公差。

STEP AP242 只作为显式回退：**x_t/x_b → STEP → 现有 STEP 转换器 → GLB**。它适用于已购买的 Provider 只能可靠输出 STEP、或需要调试几何修复的场景，但会增加转换时间、拓扑重编号、属性映射和几何容差变化风险。回退必须在任务记录中标记 `pipeline=parasolid-step-glb`，不能与直接路径共享缓存键。

Parasolid 格式本身不承诺 PMI；HOOPS 官方 reader 文档也把 Parasolid PMI 标为不支持。M5 对 x_t/x_b 的验收门槛是几何、装配、实例、变换、颜色、单位和可用属性，不把 PMI 作为必需产物。

## 标准失败码

| 失败码 | 含义 | 是否可重试 |
| --- | --- | --- |
| `PROVIDER_NOT_CONFIGURED` | 未选择或未配置执行程序 | 配置后重试 |
| `PROVIDER_EXECUTABLE_NOT_FOUND` | 命令路径无效 | 修正后重试 |
| `PROVIDER_LICENSE_UNAVAILABLE` | 许可证无效、过期或并发席位耗尽 | 许可证恢复后重试 |
| `INVALID_PARASOLID_HEADER` | 预检未识别为 x_t/x_b | 否，先检查源文件 |
| `UNSUPPORTED_PARASOLID_VERSION` | Provider 不支持该 XT 版本 | 升级 Provider 后重试 |
| `PARASOLID_IMPORT_FAILED` | B-Rep/装配读取失败 | 修复源文件或换 Provider |
| `TESSELLATION_FAILED` | 网格化失败 | 调整公差后可重试 |
| `STEP_FALLBACK_FAILED` | STEP 中间路径失败 | 换直接路径或修复源文件 |
| `GLB_EXPORT_FAILED` | GLB 写出失败 | 可重试 |
| `ARTIFACT_VALIDATION_FAILED` | GLB/层级/属性产物不合法 | 否，Provider 缺陷 |
| `RESOURCE_LIMIT_EXCEEDED` | 内存、CPU、输入或输出超限 | 提额或简化后重试 |
| `CONVERSION_TIMEOUT` | 超时 | 可重试一次 |
| `CONVERSION_CANCELLED` | 用户取消 | 可重新提交 |

错误消息可本地化，失败码、Provider 原始退出码和最近 8 KiB 日志必须结构化保存；不得把许可证错误写成“模型损坏”。

## 黄金样本验收

至少维护以下已获授权、可提交 CI 哈希但不一定提交源文件的样本：

1. x_t 单零件：mm、解析曲面、孔、倒角、颜色；固定包围盒、体积与面数范围。
2. x_b 同一零件：与 x_t 的包围盒、体积和渲染网格误差等价。
3. 装配：重复实例、嵌套变换、隐藏零件、同名零件；层级和实例数准确。
4. 旧版、当前版、比 Provider 更新一版的 x_t/x_b：分别验证成功、成功、`UNSUPPORTED_PARASOLID_VERSION`。
5. 非法/截断/扩展名伪装文件：不可崩溃，不产生半成品。
6. 大模型：2 GB 输入上限、取消、超时、进程崩溃和失败清理。
7. 直接 GLB 与 STEP 回退对照：单位、坐标、包围盒、装配节点和 Hausdorff/顶点误差在预算内；缓存键必须不同。
8. Provider 升级回归：相同输入在同一 Provider 版本与配置下产物哈希稳定；跨版本允许哈希变化，但稳定实体 ID 映射率达到约定阈值。

发布可用门槛：100% 样本无崩溃/穿越路径；单位和轴向正确；必需 GLB、层级、属性均存在；所有坐标有限；选择节点能映射到稳定对象 ID；取消后无孤儿进程和临时文件。

## 官方资料

- [CAD Exchanger 支持格式](https://cadexchanger.com/formats/)
- [CAD Exchanger Parasolid 转换能力](https://cadexchanger.com/convert-parasolid/)
- [CAD Exchanger SDK / Batch / Cloud 选型](https://cadexchanger.com/blog/which-cad-exchanger-developer-tools-are-right-for-me/)
- [CAD Exchanger SDK 私有部署](https://support.cadexchanger.com/portal/en/kb/articles/does-your-sdk-offer-an-on-premise-way-to-convert-files)
- [CAD Exchanger SDK 离线运行](https://support.cadexchanger.com/portal/en/kb/articles/would-it-be-possible-to-run-cad-exchanger-sdk-with-no-internet-access)
- [CAD Exchanger SDK 授权与分发费用说明](https://cadexchanger.com/products/sdk/pricing/)
- [HOOPS Exchange Parasolid Reader](https://docs.techsoft3d.com/hoops/exchange/start/format/parasolid_reader.html)
- [HOOPS Exchange 支持格式](https://docs.techsoft3d.com/hoops/exchange/start/supported-formats.html)
- [Datakit CrossCad/Ware](https://www.datakit.com/en/crosscad_ware.php)
- [Siemens Parasolid XT 说明](https://www.plm.automation.siemens.com/en_sg/Images/3847_tcm963-7382.pdf)
- [OCCT 开源 DataExchange 工具包列表](https://dev.opencascade.org/doc/refman/html/module_dataexchange.html)
- [OCCT 技术概览：Parasolid 位于 Advanced Data Exchange Components](https://dev.opencascade.org/doc/occt-7.4.0/overview/html/technical_overview.html)
