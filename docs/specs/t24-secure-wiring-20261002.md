# T24 订阅源安全接线报告(2026-10-02)

> 任务:把本日完成的证书批(`opcUaSecureTransport.ts`,ensureClientCertificate + createSignedOpcUaClient)接到 OPC UA 订阅源(`opcUaSubscriptionSource.ts`)。行内小批,不改 `jc-i-continuation-20261001.md`。

## 1. 现状核查(前置六步结论)

- **已有(不重建)**:`opcUaSecureTransport.ts` 证书批(3/3 测试);订阅源 `deps.createClient` 注入点 + `adaptRealClient` 收口;模拟 server 形态(port 0 临时端口解析);`describeOpcUaSubscriptionSupport` limitations 中"安全模式固定 None"如实声明。
- **消费方盘点**:`mqttIngest.ts:312 startPersistentOpcUa` 经 sourceFactory 消费订阅源(不传 security,走原 None 路径);`describeOpcUaSubscriptionSupport` 仅有无参测试调用方 → "既有无配置调用方零变化"可严格保证。
- **真实缺口**:config 无 security 字段;模拟 server 无安全变体;无 secure↔secure 端到端用例;limitations 的 None 声明在 security 配置存在时会失真。
- 基线实测:opcUa 三文件 **28 测试全绿**(接线前)。

核查证据:`test-output/t24-secure-wiring-20261002/progress-01-survey.json`。

## 2. 接线形态

### 2.1 订阅源 config 扩展(`apps/api/src/opcUaSubscriptionSource.ts`)

```ts
security?: OpcUaSecurityConfig  // { certificateManagerRootDir: string; applicationName?: string }
```

`start()` 内默认客户端工厂按三分支收口:

1. `deps.createClient` **显式注入优先**(测试/特殊宿主可控);
2. `security` 存在 → 惰性 `import("./opcUaSecureTransport.js")` 调 `createSignedOpcUaClient`(**Sign + Basic256Sha256**),经既有 `adaptRealClient` 适配为最小接口——生产路径与注入路径共享同一接口,订阅/监控/断线检测逻辑零改动;客户端自签证书同 rootDir 跨实例复用(重连不重生成);
3. 两者皆无 → 原 `MessageSecurityMode.None + SecurityPolicy.None` 匿名路径,**代码逐位不变**。

配套改动:`OpcUaClientFactory` 返回放宽为 `OpcUaClientLike | Promise<OpcUaClientLike>`,调用侧 `client = await clientFactory()`——同步注入经 await 透传,零行为变化。安全路径动态 import,模块级零 node-opcua 依赖保持不变。

### 2.2 模拟 server 安全变体(`apps/api/src/opcUaSimulatedServer.test.ts`)

`startSimulatedServer(port, options?)` 增 `securityPolicies`(传 `["Basic256Sha256"]` 时 server 声明该策略 + `allowAnonymous: true`,node-opcua 内建 PKI 在 initialize 自动生成 server 自签证书)。另增 `listSessionChannelSecurity()`:`engine.getSessions() → session.channel`(公开类型化 API)→ `securityMode/securityPolicy`,供 **server 侧**断言真实协商结果。既有无参调用不受影响。

### 2.3 支持度描述条件化

`describeOpcUaSubscriptionSupport(options?: { securityEnabled?: boolean })`:

- `securityEnabled: true` → "安全模式 Sign + Basic256Sha256(配置 security 后默认生效,客户端自签证书由 CertificateManager 管理);SignAndEncrypt 与证书吊销链未覆盖。"
- 无参 → **原字符串逐字不变**("安全模式固定 None(与 previewOpcUa 同口径);Sign/SignAndEncrypt 需宿主证书管理,留待后续子项。")——既有路由/编辑器调用方输出零变化。

## 3. 端到端结果

用例:"security 配置订阅源经签名通道收发数据,server 侧会话安全策略为 Sign+Basic256Sha256"(1315ms):

| 断言 | 结果 |
|---|---|
| 数据点数 | **4 点(≥3 达标)**:双节点初始值(0,0)+ 值变更(11,22),值逐点断言,`stats.samplesEmitted === 4` |
| 会话安全策略(server 侧真实协商) | 活动通道 `securityMode === MessageSecurityMode.Sign` 且 `securityPolicy === SecurityPolicy.Basic256Sha256`(数值/字符串枚举恒等断言,非客户端请求参数) |
| 生命周期 | `ready` 恰好一次 |
| cleanup | try/finally:`source.dispose → server.shutdown → 证书根目录 rm` 全执行 |

## 4. 既有测试零退化证明

- 基线(接线前):opcUa 三文件 **28/28** 绿;
- 接线后:同三文件 **30/30** 绿(28 既有逐位绿 + 2 新增:端到端安全订阅、describe 条件声明);
- 消费方旁证:`mqttIngest.test.ts` + `mqttIngestRoutes.test.ts` **13/13** 绿;
- 无配置零变化:新用例断言无参输出仍含"安全模式固定 None"、不含"Sign + Basic256Sha256",`sequenceSemantics` 与其余 limitations 逐条相等;
- **tsc**:`apps/api` 恰 2 错,均在 `packages/deep-engine/src/webgpu/hdrDisplayCanvas.ts`(16,23 / 29,30,ownerDocument)——域外既有错,本批文件零新增。
- 最终全量:**5 文件 43/43 全绿**,证据 `test-output/t24-secure-wiring-20261002/vitest-final.log`、`tsc-after.log`。

## 5. T24 行还剩什么(诚实登记)

| 余项 | 说明 |
|---|---|
| 路由层透传 | `mqttIngest.startPersistentOpcUa` 的 sourceFactory 未从 `OpcUaIngestConfig` 组装 security——HTTP/API 用户尚不能配签名通道;订阅源能力已就绪,接线是纯字段透传(OpcUaIngestConfig 增字段 + 一行条件展开) |
| SignAndEncrypt | 加密通道未覆盖(describe 已如实声明);证书吊销链同 |
| SubscriptionTransfer | 维持栈能力硬边界登记(node-opcua 2.178 无 TransferSubscriptions 服务实现),缺口报告对账替代 |
| previewOpcUa | 其 None 固定口径未随本批联动(独立子项) |

## 6. 资产与纪律

- 未执行 commit/push/reset/clean/stash;四项用户资产未触碰;`jc-i-continuation-20261001.md` 未改;未用 cargo。
- 变更文件:`apps/api/src/opcUaSubscriptionSource.ts`(+78/-21 行内)、`apps/api/src/opcUaSimulatedServer.test.ts`(+112);新增测试 2 例;证据与报告如上。
