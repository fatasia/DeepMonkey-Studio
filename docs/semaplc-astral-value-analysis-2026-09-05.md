# SemaPLC / Astral3D 价值分析与采用决策

核验日期：2026-09-05。状态：已完成（源码/文档分析）；不是部署、性能或工业格式真实转换验收。承接 9 月 4 日已有 SemaPLC 结论，不重复建设独立编辑器。

## 1. 结论

| 项目 | 对本平台最有价值的部分 | 本轮选择 |
|---|---|---|
| SemaPLC | 把 AI 生成控制逻辑推进到“运行输入—输出时序—行为验证”，而非只看代码是否编译 | 借鉴验证合同，映射既有虚拟调试与 Study；不安装另一套运行环境 |
| Astral3D | BIM/CAD 导入产品流程、资源化、分包加载与插件组织 | 借鉴交互和接口边界；不替换当前 Three.js/React 架构 |
| astral-service | DWG→DXF 的异步转换、状态记录与完成通知样例 | 参考流程；当前转换任务体系已覆盖更多可靠性要求，不移植 Java/MySQL 后端 |

以上是基于源码与本地实现的工程判断，不是“已超过竞品”的实测结论。

## 2. SemaPLC：价值在验证闭环，不是模型解析

官方说明提供 ST 编写、编译、运行、变量读取/强制与时序采样工具，MCP 和 CLI 共用工具链；运行环境包含 OpenPLC。它不属于 BIM/CAD 几何解析器。[项目说明](https://github.com/midea-ai/SemaPLC)

采用建议（我们的设计）：

- 将控制需求转为可审核的验证计划：初始输入、动作时刻、预期输出、容差/截止时间。
- 通过既有虚拟调试运行器执行，记录引擎版本、输入指纹、信号映射、trace 与逐项断言结果，复用统一 Study。
- 编辑器负责信号定位与播放，运营中心负责实验对比与证据；失败必须能定位信号/对象，不能只显示“AI 判断正确”。
- 未来 PLC adapter 可插拔，但真实控制器写入、完整 OLP、认证动力学不纳入本轮。

仓库自己的代码标注 MIT；第三方声明分别列出 GPL/LGPL 工具组件。不要把主仓库标签当成全部二进制的许可；本轮未复制其源码或镜像。[第三方清单](https://github.com/midea-ai/SemaPLC/blob/main/THIRD_PARTY_NOTICES.md)

## 3. Astral3D：可以学流程，不能据格式列表推断转换能力

官方列出多格式导入、BIM 轻量化、CAD 预览、场景分包和资源中心；这些是产品声明，不能等同于所有格式均能在浏览器中直接解析。[Astral3D](https://github.com/mlt131220/Astral3D)

特别注意：仓库展示 Apache-2.0，同时 README/LEGAL 包含商业授权等附加条件。采用决策是只做独立交互/架构研究，不直接移入源码；若未来引入具体模块，先取得适用范围清楚的授权记录。[作者声明](https://github.com/mlt131220/Astral3D/blob/main/LEGAL.md)

### 本机 astral-service 源码核验

只读分析目录：`D:/Temp/astral-service-analysis`；不是产品依赖目录。本轮未执行其中程序、未读取其连接凭据、未复制源码。它使用 Java 8、Spring Boot 2.7.18，配置示例为 MySQL 与本地/又拍云存储。[后端说明](https://github.com/yx8663/astral-service)

| 证据文件（相对该分析目录） | 观察到的事实 | 工程含义 |
|---|---|---|
| `astral-business/src/main/java/com/astral/business/cad/controller/Astral3DCadController.java` | `dwg2dxf` 接口调用本机转换程序，另起线程，更新任务状态并通知结果 | DWG 不等于纯前端解析；需要受控的外部转换器 |
| `astral-core/src/main/java/com/astral/core/config/webSocketConfig/RevitWsClient.java` | 有 Revit WebSocket 客户端；发送方法创建消费线程，读取方法使用阻塞队列 | 可研究桥接边界；不能直接移植其线程/取消处理 |
| 同目录 `RevitWebSocketConfig.java` | 配置类全文被注释；搜索 Java 代码未发现有效 `RevitWsClient` 调用方 | 本样本没有证据证明 RVT→glTF 端到端运行可用，更不能宣称已获得 Revit 解析器 |

静态审查发现的风险：DWG 任务按原文件名组织临时文件可能冲突；每任务新线程缺少有界排队；进程等待缺少明确超时/取消；Revit 消费线程/重连定时器生命周期值得重做。这些是源码风险判断，未做负载或漏洞复现。

## 4. 落到本项目：复用什么、补什么

本地已有 `apps/api/src/conversionTasks.ts`、Web `optimizer/modelOptimizerWorkerClient.ts`、`optimizer/modelOptimizerAssets.ts`：应继续用统一任务、Worker、素材保存链路，不建立 Astral 专用存储或第二套模型库。

目标流程：素材库选择/上传 → 格式能力检查 → 转换或直接导入 → 预览与体积/几何诊断 → 压缩/优化 → 保存新素材版本 → 返回素材库可立即使用。保留原始模型与来源，不用优化输出静默覆盖原件。

补齐优先顺序：

1. 明确区分“原生导入 / 外部转换器可用 / 等待转换器 / 仅结构探测”，不宣传所有输入都可转 GLB。
2. 失败后保留参数、可取消和重试；成功显示原始/输出体积及使用的变换，不虚报压缩率。
3. 几何与 BIM 属性分离但稳定引用，验证构件 ID、单位、坐标、层级和材质纹理不丢失。
4. 大文件解析按现有 Worker 边界治理，用真实夹具比较时间/峰值内存/画面；不能凭竞品有 Worker 就声明性能领先。

工业格式真实转换、Revit 安装和 Docker 运行验收：明确排除（本轮）；不影响既有能力继续可用。

## 5. 仿真面板对标补充

采用“中央 3D 视口 + 可重排工具窗 + 上下文检查器 + 统一时间”的工作台原则。Siemens 官方 Plant Simulation 手册提供停靠/自动隐藏参考；不能把 Plant 的具体操作冒充当前 Process Simulate 版本的逐像素 UI。[Siemens 手册](https://www.plm.automation.siemens.com/en_us/Images/PlantSimulation_Step-By-Step_ENU_tcm1023-143387.pdf)

本轮已实现紧凑拖动/缩放/折叠工具窗、实体写回和静态路径覆盖层。自动停靠/固定边栏、统一仿真时间线、运行热力/KPI 仍是本轮待办；切换面板当前会卸载子面板，不能宣称未提交表单已经跨页保留。

页面入口与图层职责分离参考 Figma 文档，但页面放底部是本项目用户明确决策，不照抄 Figma 的页面位置。[Figma 导航与侧栏](https://help.figma.com/hc/en-us/articles/360039831974-Explore-the-navigation-bar-and-left-sidebar)
