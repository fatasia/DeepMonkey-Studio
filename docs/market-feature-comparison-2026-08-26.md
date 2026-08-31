# iTwin Studio 逐功能市场对比矩阵

评估快照：2026-08-26，2026-08-30 补充图扑软件 HT for Web。对照对象为 ThingJS、FineVis/FineBI、山海鲸、图扑 HT for Web、51WDP 和 Unity 6。

本矩阵只记录本次查到的官方公开资料与当前仓库证据。`●` 表示所列官方资料明确覆盖，`△` 表示只覆盖相邻能力或产品形态不同，`—` 表示本次公开资料抽样未找到足够证据，**不表示竞品一定没有该能力**。商业版、私有版和未公开能力需要单独 PoC，不能从营销页反推。

## 市场公开能力基线

| 功能 | ThingJS | FineVis / FineBI | 山海鲸 | 51WDP | Unity 6 | 对 iTwin Studio 的有效门槛 |
|---|---:|---:|---:|---:|---:|---|
| 2D 可视化画布、组件与图层 | △ | ● | ● | ● | △ | 至少具备拖放、图层、组合、对齐、快捷键、预览与多分辨率适配 |
| 图表、表格、图片、视频、监控 | △ | ● | ● | ● | △ | 设计、预览、发布三条路径一致，媒体失败可诊断 |
| 自助数据准备与语义联动 | △ | ● | ● | ● | — | 字段、公式、过滤上下文、默认/手动联动和可追踪来源 |
| HTTP/API、数据库与实时数据 | ● | ● | ● | ● | △ | HTTP/WebSocket/MQTT 等需有鉴权、限流、重连、质量和发布治理 |
| 2D/3D 事件联动 | ● | ● | ● | ● | △ | 同一事件模型双向定位，设计态可调试，运行态不静默写回 |
| 园区→建筑→楼层→设备层级 | ● | △ | ● | ● | ● | 连续下钻、返回、相机与页面状态恢复，加载失败保留父层 |
| 三维对象、相机、效果与事件 API | ● | △ | ● | ● | ● | 常用能力编辑器可配，长尾能力由稳定公开 SDK/插件实现 |
| 第一/第三人称与相机跟随 | ● | — | △ | △ | ● | 模式切换、碰撞/重力、相机恢复和低帧压力浏览均需实测 |
| 多场景异步/增量加载 | △ | — | △ | ● | ● | 明确 replace/additive/focus 策略、预算、失败恢复和资源释放 |
| 动画、时间线与镜头编排 | △ | ● | ● | ● | ● | 多轨、暂停/倍速/复位、事件与确定性回放，不只播放视频 |
| BIM/GIS 与工业场景深度 | △ | △ | ● | ● | △ | 保留构件语义、坐标、剖切、属性和可验证的转换质量 |
| 蓝图/低代码交互编排 | △ | ● | ● | ● | ● | 节点/动作契约、错误定位、调试记录、撤销和版本迁移 |
| JavaScript/C#/组件二开 | ● | △ | ● | ● | ● | 版本化 API、类型、权限、沙箱、预算、日志和可安装样例 |
| 本地/私有化交付与系统集成 | ● | ● | ● | ● | ● | 离线资源、身份、发布回滚、升级和故障恢复需端到端证据 |
| 运行时资源与性能诊断 | △ | — | — | △ | ● | 首帧、帧时间、内存/显存、切换残留、长任务和固定工作负载 |
| WebGPU 优先、WebGL 兼容 | — | — | — | — | ●（Unity 6000.6 WebGPU 正式支持并可回退） | WebGPU 已是对 Unity 的正式一级门槛；必须用同场景画质、GPU 帧时、首帧、短时资源稳定和恢复矩阵证明，而非口号 |

### 图扑 HT for Web 的独立门槛

图扑官方指南强调 GraphView（2D）与 Graph3dView（3D）可共享 DataModel，并尽量保持 API 一致；其 2D 侧还覆盖节点、连线、编辑、自动布局和工业图元。这一产品结构不能只用“也有 2D/3D”代替。对本项目的有效门槛是：同一稳定对象模型在 2D、3D、拓扑、Unity 嵌入和脚本中不重复建模；对象状态、选择、显隐和数据更新能跨视图复用；基础 API 扁平、类型化且不要求用户理解内部渲染器层级。当前统一 ApplicationDocument、拓扑数据、2D/3D/脚本上下文和 `studio.unity()` 是纵向切片，尚不能声称全面超过 HT for Web 的成熟图元、布局和行业实施积累。

## iTwin Studio 当前证据状态

状态：`已验证` = 本次真实浏览器或自动化测试有证据；`部分` = 有可运行纵向切片但未过完整门槛；`未验证` = 代码/入口可能存在但缺少要求的证据；`未实现` = 当前确认缺失。

| 功能 | 状态 | 当前仓库/本次证据 | 仍缺什么 |
|---|---|---|---|
| 一键可编辑综合案例 | **已验证** | `apps/web/src/showcase/industrialShowcase.ts`、场景管理器真实创建 4 场景/4 页面并进入预览 | 仍需模板版本迁移、重复创建治理和对外发布回归 |
| 4K 2D 看板与多页面切换 | **已验证** | 四页均为 3840×2160；1280×720 与 1024×768 浏览器检查无关键入口越界 | 980px、125% 缩放、300 组件压力和更多空/失败态 |
| 程序化 3D 园区/车间/产线/机器人 | **已验证** | 四个实时 `SceneViewportWidget` 使用原创程序化几何，无外部受保护资产 | 真实中大型 BIM/GLB 资产和材质画质基准 |
| 楼层与机器人部件拆解 | **已验证** | 两条时间线自动播放；浏览器实测暂停、播放、复位控件 | 复杂层级、保存刷新、异常中断与无障碍操作 |
| 第一/第三人称 | **已验证（基础）** | 车间提供两种相机视角；浏览器点击后画面与相机实际变化 | 薄墙/门洞/台阶低帧压力、碰撞与出生点恢复门禁尚未跑 |
| 物流、AGV 与拓扑 | **已验证（展示切片）** | Source/Process/Buffer/Sink/AGV 拓扑；AGV 速度、状态、位置和颜色绑定 | M8 的实时/仿真/历史同对象切源和大规模事件压力未验证 |
| 图片、视频、模拟实时监控 | **已验证** | 原创 SVG、12 秒 H.264 MP4、两路本地 Canvas 实时监控均在浏览器渲染 | 真实 HLS/RTSP 转码、断流重连与发布路径一致性未完成 |
| 直连 HTTP/WebSocket | **已验证（同机）** | `/api/public/demo/industrial` 与 `/ws`；HTTP 值实测持续变化，API WS 契约测试通过 | 外部真实上游、401/超时/断流、复用连接和发布环境故障注入 |
| 确定性模拟数据 | **已验证** | `apps/api/src/industrialDemo.ts` 固定种子和时间输入测试 | 尚未等同于 M8 离散事件仿真可信度或历史回放 |
| 2D→3D 相机/对象联动 | **已验证（案例路径）** | 第一/第三人称卡片驱动三维相机；页面与场景引用完整性测试 | 四类双向联动的统一调试器和错误恢复仍是部分能力 |
| Worker 行为脚本与审计元数据 | **部分** | 案例内置 `worker-sandbox` 生命周期脚本；合同与插件测试存在 | 专业调试、超时/死循环浏览器证据、权限审计和迁移工具 |
| ApplicationDocument 单一事实源 | **部分** | 综合案例完整使用 ApplicationDocument | 旧 SceneSnapshot 编辑路径仍并存，跨场景/应用保存不是单事务 |
| WebGPU 优先与 WebGL 回退 | **部分** | 新渲染能力以 WebGPU 路径为目标；本机双向切换保留场景且无新增错误 | R1–R5 尚未过门，故生产默认仍诚实保留 WebGL；后处理/XR、画质、帧时间、显存和设备丢失矩阵未完成 |
| 场景切换稳定性 | **已验证（短测）** | 修复 WebGL context 释放后，同机会话 20/20 次切换 ready，无新增错误 | 内存/显存残留、崩溃恢复和多应用压力 |
| Data Hub 与跨组件分析 | **部分** | 连接器、数据集、Pipeline、公式、直接绑定和运行日志已有测试 | FineBI 级模型/语义、自动联动、钻取、级联参数和大数据量证据 |
| BIM/CAD 转换、地图与拓扑 | **部分** | 常用格式链路、轻量地图与 TopologyEditor 已有纵向切片；RVT/XT/JT 已有受控上传、Provider 目录、任务和 MCP/SDK 边界 | 用正式样本与商业 Provider 完成装配/属性/PMI/版本矩阵验收；不承诺无依赖直读 |
| 插件/SDK 企业生态 | **部分** | scene-sdk、plugin-runtime、示例插件与合同测试存在 | 签名仓库、第三方不改核心迁移任务、兼容升级、安全禁用与市场流程 |
| Tauri 本地客户端 | **部分** | `apps/desktop` 与基本测试存在 | 安全令牌、OAuth 回调、恢复点、续传、安装签名和自动更新 E2E |
| 云渲染 | **已验证（单节点）** | 真实 Chromium GPU Worker；RTX 4060 Laptop GPU、H265 硬件编码、1280×720 WebRTC 媒体、输入 DataChannel、RTP 证据和会话资源回收均已通过 | TURN/公网部署、多 Worker 调度、会话隔离、容量保护与同机 Unity 延迟/画质对照 |
| M8 工厂物流仿真 | **部分** | Factory Flow 插件和单元测试存在；综合案例提供物流可视化 | 首版切源门槛、插件故障全流程、正式实验、校准和压力证据 |
| M9 文档产品 | **部分** | 内嵌 Markdown 文档中心、搜索与测试存在 | 500 页 p95、版本联动、全章节/断链、离线 Tauri 和示例类型检查 |
| AI Copilot | **已进入受控插件化建设** | 已有 AI Provider、权限与确认边界；完整评测和主流程证据仍不足 | 继续核对 IoT-NB/电池正式模型接口和统一确认闭环；FATHOM 已明确放弃，不作为集成来源 |

## 结论

iTwin Studio 本轮已经有一个覆盖 2D、3D、层级、拆解、人物视角、AGV、媒体和直连数据的可编辑案例；这使它从“能力散点”进入“可演示纵向切片”。但它仍不能声称总体超过任一对照产品：FineVis/FineBI 的数据分析与成熟看板工作流、ThingJS/51WDP 的公开 API 与交付生态、山海鲸的低门槛与私有化广度、图扑 HT for Web 的统一 DataModel/2D-3D 图元与行业实施积累、Unity 的渲染/时间线/性能工具链，均存在当前 iTwin Studio 没有完整证据的维度。

下一轮最高价值不是继续增加入口，而是把现有切片做成可持续门禁：统一应用保存、外部 HTTP/WS 故障注入、R1–R5 双后端性能/画质、Parasolid 实转换，以及云渲染从单节点闭环走向可部署运行。

## 本次采用的官方公开资料

- ThingJS API 索引与场景层级：[API 索引](https://docs.thingjs.com/cn/apidocs/)、[SceneLevel](https://docs.thingjs.com/cn/apidocs/THING.SceneLevel.html)、[场景层级教程](https://docs.thingjs.com/cn/App_dev/Tutorial/Content/scene_level.html)、[摄像机](https://docs.thingjs.com/cn/App_dev/Tutorial/Content/camera.html)。
- FineVis/FineBI：[FineVis 简介](https://help.fanruan.com/finereport/edition-view-61611-0.html)、[FVS 组件操作及快捷键](https://help.fanruan.com/finereport/edition-view-60885-19.html)、[FVS 组件交互](https://help.fanruan.com/finereport/edition-view-64673-19.html)、[FineBI 组件联动](https://help.fanruan.com/finebi/doc-view-150.html)。
- 山海鲸：[开发概述](https://www.shanhaibi.com/docs/v1/dglzot41g9igan51)、[绑定数据到组件](https://www.shanhaibi.com/docs/v1/lu4w0o/)、[系统集成概述](https://www.shanhaibi.com/docs/v1/eeada2g6474zva1u/)、[产品白皮书](https://static.shanhaibi.com/web/docs/%E5%B1%B1%E6%B5%B7%E9%B2%B8%E5%8F%AF%E8%A7%86%E5%8C%96%E4%BA%A7%E5%93%81%E7%99%BD%E7%9A%AE%E4%B9%A6.pdf)。
- 51WDP：[产品功能与流程](https://wdp.51aes.com/product-service5?loggedIn=false)。
- Unity 6：[Additive Scene](https://docs.unity3d.com/6000.1/Documentation/ScriptReference/SceneManagement.LoadSceneMode.Additive.html)、[LoadSceneAsync](https://docs.unity3d.com/ja/current/ScriptReference/SceneManagement.SceneManager.LoadSceneAsync.html)、[Timeline](https://docs.unity3d.com/ja/current/Manual/com.unity.timeline.html)、[运行时资产管理](https://docs.unity3d.com/cn/6000.0/Manual/assets-managing-runtime.html)、[Frame Timing Manager](https://docs.unity3d.com/kr/6000.0/Manual/frame-timing-manager.html)。
- 图扑 HT for Web：[产品页](https://www.hightopo.com/)、[入门与 GraphView/DataModel](https://www.hightopo.com/guide/guide/core/beginners/ht-beginners-guide.html)、[3D 指南](https://www.hightopo.com/guide/guide/core/3d/ht-3d-guide.html)、[自动布局](https://www.hightopo.com/guide/guide/plugin/autolayout/ht-autolayout-guide.html)。
