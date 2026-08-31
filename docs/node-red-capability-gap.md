# 数据中台与 Node-RED 能力差距审计

审计日期：2026-08-26  
审计范围：`apps/node-red`、数据中心 UI、数据流水线运行时、数据接口 API。  
结论：**当前数据中台不具备 Node-RED 的全部能力，也不应这样宣传。** 仓库里有两套互补但不同的能力：

1. 平台内置数据流水线：面向可复用数据产品，提供受控的数据集、转换、逐节点诊断、REST/WebSocket 输出和 2D/3D 绑定。
2. 独立 Node-RED 运行时：面向事件驱动、IoT 协议和通用流程扩展。它需要单独启动，可用能力取决于实际安装的节点包。

本次补齐了数据中心到独立 Node-RED 的正式入口与同源代理，并修复了内置 TDengine/Oracle 示例流被调试语句提前截断、Oracle 查询未连接规范化节点的问题。这让用户可以在同一数据中心进入真正的事件编排运行时，但不等于内置流水线已经复制了 Node-RED。

## 事实矩阵

| 能力 | 独立 Node-RED（当前仓库） | 平台内置数据中台 | 结论 |
|---|---|---|---|
| 可视化流程画布 | Node-RED 5.0.4 编辑器，支持任意连线、分支和多输出 | 运行时能验证 DAG 和 `merge`；当前 UI 只编排线性链 | 部分具备，内置 UI 有明显缺口 |
| 事件驱动执行 | `inject`、HTTP、WebSocket 及 Node-RED 消息运行时 | 数据集预览和流水线预览以请求触发；WebSocket 接口按固定间隔重跑流水线 | 内置不等价 |
| 路由与消息变换 | Node-RED 核心 Switch/Change/Function/JSON 等节点由运行时提供 | Filter、Formula、隔离脚本、Sort、Limit；没有多输出 Switch/Change | 部分具备 |
| 子流程与复用 | Node-RED Subflow、Link 节点 | 无子流程、模板或可复用节点组 | 缺失 |
| 节点/流程/全局状态 | Node-RED context API | 流水线运行无持久上下文 | 缺失 |
| 异常流与恢复 | Node-RED Catch、Status、Complete 等事件节点 | 返回失败节点和逐节点诊断；无异常分支、重试、退避或死信 | 部分具备 |
| 调试与观测 | Debug 侧栏、节点状态、部署反馈 | 预览表格、耗时、输入/输出行数和错误节点 | 两者各有覆盖，内置偏数据诊断 |
| 部署模型 | Node-RED Deploy，运行中的消息流 | 保存定义后由 API 请求或端点执行，没有常驻流水线调度器 | 内置缺少常驻执行 |
| 导入导出 | Node-RED 流 JSON 导入导出 | 没有数据流水线导入导出 UI/API | 缺失 |
| 版本管理 | Node-RED Projects 可支持 Git，但本仓库 `projects.enabled=false` | 数据流水线只保存当前版本 | 当前两侧都没有可用版本工作流 |
| Dashboard | 已安装 FlowFuse Dashboard 1.30.2 | 2D 大屏和 3D 数据绑定是平台原生能力 | 都具备，但目标不同 |
| HTTP / WebSocket | Node-RED 核心节点；已有 `/iot/scene` 和 `/iot/ws/scene` 桥 | HTTP 数据集可预览；原生 REST/WebSocket 数据产品接口带 API Key 和限流 | 具备，平台原生安全契约更明确 |
| MQTT / TCP / UDP | Node-RED 标准节点随运行时可用 | MQTT 已有原生服务端订阅采样；TCP/UDP 已有原生采样预览（TCP 按行读取，UDP 监听窗口采样） | 两侧具备；原生仍是请求触发预览，不等同于常驻采集 |
| PostgreSQL / MySQL 协议数据库 | 已安装 `node-red-contrib-postgresql`、`node-red-node-mysql` | PostgreSQL、MySQL、MariaDB、TiDB、Apache Doris、StarRocks 均有原生只读预览；后四者经已验证的 MySQL 协议直连，而不是经 HTTP 伪装 | 两侧具备，配置模型不同 |
| Oracle / TDengine | 已安装 Oracle、TDengine 相关包并提供禁用的示例流 | API 有直接预览实现 | 两侧具备；仍需真实环境集成测试 |
| OPC UA / Modbus TCP / BACnet | 已安装对应 contrib 节点 | OPC UA NodeId 读取和 Modbus TCP 寄存器读取已接入原生预览；BACnet 未实现 | OPC UA/Modbus 两侧具备，BACnet 仅 Node-RED 侧具备 |
| S7 / EtherNet/IP / BACnet / CoAP / Serial | 当前 `apps/node-red/package.json` 没有对应节点包 | 原生暂未执行；SNMP、AMQP/RabbitMQ 已有原生只读采样 | 长尾协议仍需 Node-RED 或专用网关；入口不等于实现 |
| Kafka | 未安装 Kafka 节点包 | 原生数据中台已接入 Broker、Topic、Consumer Group、SSL 与 SASL/环境变量密码，预览会真实消费消息 | 原生数据中台具备，独立 Node-RED 当前未安装对应节点 |
| 凭据管理 | Node-RED credential store；管理员认证仅在环境变量同时配置时启用 | 数据库密码引用服务端环境变量；数据端点密钥只保存哈希 | 基础具备；生产仍需强制认证和密钥轮换策略 |
| 第三方节点生态 | `externalModules.autoInstall=false`，只能由部署者安装并重启 | 没有节点插件市场 | 受控可扩展，不是开箱即用全部生态 |
| 高可用与水平扩展 | 未发现队列、分布式状态或主从部署配置 | 未发现任务队列、分布式调度或检查点 | 未具备 |
| 自动化测试 | `validate-flows.mjs` 做静态结构/脚本校验 | 数据运行时、API 路由有单元和注入测试 | 缺少带真实 Broker/PLC/数据库的端到端测试 |

## 本次实现

- 数据中心新增“高级编排”页签，嵌入 `/node-red/` 编辑器，并明确标注这是独立运行时。
- 工作台显示可直接复制的完整 HTTP 写入地址和 WebSocket 平台消费地址；Node-RED 中的 MQTT/TCP/UDP/社区节点先转为统一场景消息，再由平台消费，避免核心数据层依赖 Node-RED。
- 提供“运行看板”和“新窗口打开”，避免 iframe 不适合复杂编辑时卡住工作流。
- Vite 增加 `/node-red` 与 `/iot` 的 HTTP/WebSocket 代理，开发环境不再出现 README 有链接但 5173 无代理的断点。
- 修复内置 TDengine/Oracle 示例流：移除规范化 Function 的提前 `return`，并把 Oracle 查询重新连接到规范化节点。
- 强化 Node-RED 流校验，确保内置和导出示例的规范化逻辑一致、Oracle 连线不会再次退化。
- 平台原生新增 Kafka、MQTT、WebSocket、OPC UA、Modbus TCP、CoAP、SNMP、AMQP/RabbitMQ、TCP、UDP 可执行采样器；未实现协议由 UI 标记并由 API 返回 501，不能仅凭下拉项宣称支持。
- 平台原生增加 `simulation` 开发连接器：通过 `sim://telemetry` 或 `sim://alarm` 生成确定性遥测数据，支持 `rows`、`seed`、`interval`、`start` 参数和可选 JSON 路径。数据集字段契约不变，因此可在开发阶段无缝替换为 HTTP、数据库或消息源。
- 数据中心连接卡片增加“测试连接”：调用 `/api/projects/:projectId/data-connections/:connectionId/test`，按已有数据集执行真实采样并返回健康状态、耗时、字段数和样本行数；模拟连接无数据集时使用内存探针，不落库。

启动方式：`pnpm dev:all`，然后在数据中心打开“高级编排”。只运行 `pnpm dev` 时 Node-RED 不会启动，这是刻意保持的独立运行边界。

## 主流市场连接器差距

当前原生可执行连接器是 PostgreSQL、MySQL 协议族（含 MariaDB/TiDB/Doris/StarRocks）、SQL Server、Oracle、TDengine、ClickHouse、MongoDB、Elasticsearch/OpenSearch、InfluxDB、Prometheus、CSV、Excel、HTTP、WebSocket、MQTT、Kafka、AMQP/RabbitMQ、CoAP、SNMP、TCP、UDP、OPC UA、Modbus TCP。它们已能真实连接和采样，但多数仍是请求触发的预览器，不能等同于具备检查点、背压、双向控制和长期运维的生产采集服务。

| 范围 | 当前主要缺口 | 对标依据与判断 |
|---|---|---|
| 关系库/数仓 | DB2、GaussDB、Hive、Trino/Presto、Spark、HBase、SAP HANA/BW；达梦、人大金仓和云数仓/云 IoT 明确不在本次范围 | FineReport 通过 JDBC/JNDI、SAP、XMLA 和插件覆盖大量数据库；当前优先补高频协议，避免堆无法验证的下拉项 |
| NoSQL/时序/搜索 | Redis、TimescaleDB、OpenTSDB、Graphite、Loki、Tempo、Parquet | MongoDB、ES/OpenSearch、InfluxDB、Prometheus 已具备，下一步按真实场景补齐 |
| 工业协议 | BACnet、S7、EtherNet/IP、Serial 尚未原生执行；其后还有 IEC 104、DNP3、KNX、CAN 等行业长尾 | CoAP、SNMP、TCP/UDP、AMQP 已接入只读采样；长尾优先由 Node-RED 网关承接，再按客户频率原生化 |
| 云消息/IoT | RabbitMQ、Pulsar、NATS、Kinesis、SQS、Azure Event Hub/Service Bus、Google Pub/Sub、AWS/Azure IoT Hub | 主流 IoT 平台普遍覆盖消息队列、云事件总线和云 IoT 平台，不能只对标 MQTT/Kafka |
| 文件/API | CSV、Excel、JSON、XML、Parquet、SFTP、S3/OSS、GraphQL、OData、SOAP | 这是 BI 自助接数的高频入口，当前不能要求用户先建数据库或编写 Node-RED Flow |
| 生产深度 | Kafka offset/checkpoint、Schema Registry、MQTT QoS/持久会话、OPC UA 安全策略/证书与写值/方法调用、Modbus 写寄存器、死信/背压/历史补数 | ThingsBoard 的集成模型覆盖 uplink/downlink、转换器和 RPC；当前平台已为数据集预览提供瞬态错误重试/退避，但多数连接器仍是读取采样，不能宣称具备长期采集服务 |
| 企业治理 | 连接池、mTLS/Kerberos/SCRAM、SSH 隧道、凭据轮换、Schema 漂移、吞吐/延迟指标、血缘、审计、批量测试与环境迁移 | 这些能力决定“能演示”和“能长期运营”的差别，优先级高于继续增加下拉项 |

资料基线：FineReport [数据连接概述](https://help.fanruan.com/finereport/doc-view-100.html)；ThingsBoard [Integrations](https://thingsboard.io/docs/user-guide/integrations/) 与 [Integration Types](https://thingsboard.io/docs/user-guide/integrations/integration-types/)；Node-RED [核心概念与节点扩展](https://nodered.org/docs/user-guide/concepts)。

## 推荐路线

### P0：从“嵌入编辑器”走向可运营集成

- 增加 Node-RED 健康检查、版本和已安装节点清单 API，在页签里显示真实在线状态，不能只依赖 iframe。
- 默认强制 `adminAuth`，由平台统一生成 credential secret，并对 `/node-red` 做角色权限映射。
- 建立 Node-RED 场景消息节点包，替代手写 Function JSON，提供对象选择器、动作 schema 和预览。

### P1：补内置流水线的工业数据产品能力

- 把运行时已有的多源 `merge` 和 DAG 正式开放到 UI，并增加 Join、Group/Aggregate、Window、Deduplicate。
- 增加 Switch 多分支、Catch/Retry、子流程和导入导出；保存时做连接级 schema 校验。
- 引入常驻调度器与事件触发器，区分批处理流水线和实时流，支持检查点、背压、死信及运行历史。

### P2：按需求安装连接器，不做假入口

- 继续补 Kafka offset/Schema Registry 与常驻消费，再实现 Siemens S7、EtherNet/IP、BACnet、CoAP、Serial；SNMP、AMQP、TCP/UDP 已有只读采样，但仍需生产级常驻消费、断线重连和下行能力。
- 每个连接器必须同时有配置 schema、密钥处理、连接测试、运行指标、断线重连和真实服务集成测试，完成前继续标为“需连接器”。

### P3：版本与交付

- 启用受控的流版本、差异对比、回滚、环境变量映射和 dev/test/prod 发布审批。
- 把 Node-RED flow、平台数据流水线、数据连接契约与场景绑定纳入同一个项目发布清单，但保持运行时隔离，避免一个脚本节点拖垮编辑器/API。

## 验收口径

只有当以下条件同时满足时，才可以说“平台覆盖 Node-RED 的核心应用场景”，仍不应说“所有能力”：

- 至少覆盖事件触发、分支、状态、异常流、子流程、调度、导入导出和运行历史。
- 目标工业协议通过真实设备或协议模拟器的断线、重连、吞吐和安全测试。
- Node-RED 与原生流水线的权限、凭据、审计、版本和发布流程统一可见。
- 能力清单由运行时自动探测生成，不再依据 UI 下拉项或 `package.json` 推断。
