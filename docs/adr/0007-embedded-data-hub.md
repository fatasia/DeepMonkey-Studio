# ADR-0007: 采用编辑器内嵌的轻量数据中台

## Status

Accepted

## Context

Industrial Studio 的主体是连贯的一体化 2D/3D 编辑器，但工业项目还需要接入数据库、HTTP、WebSocket、MQTT、OPC 等数据，进行过滤、映射、计算和状态逻辑，并向外提供 REST API 或实时 WebSocket。若二维、三维、拓扑和地图各自实现数据源与绑定，数据查询、公式、权限和故障语义会迅速分叉。

帆软 BI 的优势是自助数据准备、字段拖拽、即时预览和基于数据关系的默认联动；ThingJS 森数据 DIX 的优势是连接器、可视化逻辑、在线 JavaScript 和 HTTP/WebSocket 数据服务。传统数据中台常包含数据湖、数仓、主数据、目录、治理审批、调度和多组织运营，这些能力会掩盖编辑器主线并显著增加部署与维护成本。

## Decision

- M3 在现有服务器模块化单体中实现项目内嵌的轻量 `Data Hub`，不建设独立产品、独立账号、独立门户或微服务集群。
- 2D/3D 编辑器是主体；Data Hub 和模型资产系统是支撑。新增数据能力必须直接服务于可视化项目的接入、处理、接口、绑定、调试或发布。
- Core 只定义 `ConnectionDefinition`、`DataSchema`、`DatasetDefinition`、`PipelineDefinition`、`LogicModule`、`ApiEndpointDefinition`、`StreamEndpointDefinition` 和 `BindingSpec` 等可序列化契约。
- 连接器、处理节点和协议适配器通过 `DataNodePlugin` 注册。插件声明配置/输入/输出 Schema、凭据类型、运行位置、capability、版本和资源上限；核心不硬编码厂商或行业连接器。
- 用户体验采用一份模型、渐进式三层操作：零代码拖拽与默认联动；低代码 Pipeline、公式和状态机；专业级受限 SQL/TypeScript 与声明式 API/WebSocket。
- 数据处理输出统一成为有 Schema 的数据产品：表、指标、状态、事件或命令。二维、三维、拓扑和地图只绑定数据产品，不直接依赖连接器实现。
- 所有编辑器共享一个 `BindingSpec` 和 Binding Runtime。绑定只引用稳定 `TargetRef + property/capability`，不持有 React、Three.js、地图引擎或插件私有对象。
- 同一实时事件进入统一状态存储。二维可以节流/聚合，三维运动可以插值/外推，但必须共享原始时间戳、质量状态和可追踪来源。
- REST 与 WebSocket 是发布包的一部分。项目脚本不能直接注册任意服务器路由，只能创建声明式、有 Schema、有权限和资源预算的 endpoint。
- Data Hub 与应用版本一同校验和发布；活动接口随不可变发布版本原子切换。设计态预览使用隔离会话，不产生匿名公共服务。
- 凭据只保存于服务器凭据库。浏览器和 Tauri 文档仅保存凭据引用；脚本、日志、样例和异常不能读取或泄漏凭据。

## Core and plugin boundary

```text
Editor UI
  ├── Data drawer / Pipeline editor / Endpoint editor
  └── shared Binding editor
            │
        Data Hub contracts
            │
  ┌─────────┼───────────┐
Connector  Transform   Endpoint       <- DataNodePlugin
 plugins    plugins     adapters
  └─────────┼───────────┘
       isolated Data Runtime
            │
   Binding Runtime / Event Bus
      ├── 2D runtime
      ├── Scene runtime
      ├── Topology runtime
      └── Map runtime
```

Data Hub 核心不得依赖具体数据库驱动、MQTT/OPC SDK、React、Three.js 或 Tauri。插件不得深层导入编辑器 feature 或绕过凭据、权限、Schema 校验、背压和发布机制。架构测试阻止反向依赖、循环依赖和插件私有 API 泄漏。

## Explicit non-goals

M0 至 M7 不建设：

- 数据湖、湖仓、通用数仓建模或大数据计算平台；
- 主数据管理、企业级数据目录、数据交易或跨组织资产运营；
- 通用 ETL 调度集群、复杂审批治理或独立运维门户；
- 机器学习训练/特征平台；
- “内置所有数据源”的连接器市场；
- 脱离 2D/3D 应用独立售卖和运行的通用 BI 产品。

Schema、直接血缘、质量状态和运行指标仅保留绑定兼容、调试、权限、审计和发布所需的最小集合，并尽量自动推断，不要求用户维护企业级元数据。

## API and stream contract

- REST 契约可导出 OpenAPI 3.1；异步通道可导出 AsyncAPI 3.0；消息和数据字段使用 JSON Schema 2020-12 子集。
- REST endpoint 声明方法、路径、请求/响应、逻辑、认证、授权、限流、超时、缓存和错误映射。
- 一个应用级 WebSocket 连接复用多个 channel，消息信封至少包含 `type`、`channel`、`messageId`、`correlationId`、`timestamp`、`schemaVersion` 和 `payload`。
- WebSocket 握手与每条消息都授权，并实现 Origin 白名单、消息大小/速率限制、心跳、背压、慢消费者处理、重连游标和审计。
- 第一批插件只交付 HTTP/REST、WebSocket、MQTT、PostgreSQL/MySQL、CSV/Excel；OPC UA 通过服务器或受限网关接入。其他连接器按真实项目需求扩展。

## UX requirements

- 用户选择任意二维组件或三维对象后，都从同一“数据”抽屉完成：选择数据产品、字段/事件、目标属性/能力、转换与更新策略、样例预览。
- 数据准备与绑定使用即时样例，显示 loading、empty、stale、offline、error、unauthorized 和 schema-incompatible 状态。
- 默认联动必须可解释：显示系统根据哪张表、哪个键或哪条关系建立联动，并允许一键关闭或转换为手动作用域。
- 从绑定现场可就地创建计算字段或派生数据集，保存后自动返回原组件，不让用户在多个独立工具之间迷路。
- 调试器支持从“数据到目标”和“目标到数据”双向追踪最近值、公式、节点耗时、丢弃、权限、版本和错误。

## Non-functional requirements

- Data Hub 模块禁用或故障时，纯静态 2D/3D 编辑、预览和已有不依赖数据的发布仍可运行。
- 所有数据执行都有取消、超时、并发、内存、响应大小和消息频率预算；慢源和慢消费者通过背压隔离。
- 脚本死循环、连接器崩溃或单条坏消息只能熔断对应节点/流水线，不能拖死编辑器或其他项目。
- 相同发布包、相同输入事件与时间基准在 B/S、Tauri 和云渲染中产生一致的绑定与业务事件结果。
- 连接器或 Schema 升级先给出兼容报告；不兼容变化不能静默覆盖线上接口或绑定。
- 常用绑定不写代码可完成；高级能力通过展开区或专业模式提供，不让连接、数据集、接口和监控同时堆满一个页面。

## Consequences

### Positive

- 2D/3D 使用同一数据语义、公式、质量状态和调试链，避免割裂。
- 新手获得类似 BI 的低门槛，高级用户保留脚本、接口和插件扩展能力。
- 一套账号、项目和发布模型即可管理编辑器、数据与对外服务。
- 插件化连接器和节点可以按项目增加，而不膨胀核心代码与默认部署。

### Negative

- 服务器需要安全的隔离执行、凭据库、WebSocket 会话和运行观测能力。
- 统一 Binding Runtime 前期设计成本高于各编辑器直接请求接口。
- 不提供传统数据中台的全部治理与计算能力，超出范围的项目需要接入现有企业数据平台。

## Failure modes

| Failure | Impact | Mitigation |
| --- | --- | --- |
| 数据源变更字段 | 绑定或接口失效 | Schema diff、影响分析、样例回归、阻止不兼容发布 |
| Pipeline/脚本死循环 | 运行资源耗尽 | Worker/进程隔离、预算、超时、取消、熔断 |
| 实时消息过快 | 内存增长、画面卡顿 | 有界队列、背压、节流/聚合、慢消费者断开 |
| 接口越权 | 数据或设备控制泄漏 | 发布前权限检查、握手与逐消息授权、审计 |
| 插件故障 | 某类连接器不可用 | 插件隔离、健康状态、安全禁用、核心可继续运行 |
| 数据模块不可用 | 动态应用失去实时数据 | 明确质量状态、最后有效值策略、静态编辑不受影响 |

## References

- [Industrial Studio 产品与架构规划](../dev-studio-product-and-architecture-plan.md)
- [ThingJS 森数据 DIX](https://www.thingjs.com/guide/dix/)
- [ThingJS 森数据产品文档](https://support.thingjs.com/book/dix-docs)
- [FineBI 自助数据集](https://help.fanruan.com/finebi/doc-view-43.html)
- [FineBI 组件联动](https://help.fanruan.com/finebi/edition-view-28389-0.html)
- [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0.html)
- [AsyncAPI 3.0](https://www.asyncapi.com/docs/reference/specification/v3.0.0)
- [JSON Schema 2020-12](https://json-schema.org/draft/2020-12)
- [OWASP WebSocket Security](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)
