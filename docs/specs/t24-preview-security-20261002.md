# T24 previewOpcUa 安全联动报告(2026-10-02)

> 任务:把订阅源/路由两批已就绪的 security 能力(Sign + Basic256Sha256)联动到 preview 链——`previewOpcUa` 保持 None 默认,支持可选安全配置(与订阅源 `config.security` 同形:可选字段,无则零退化)。行内小批,不改 `jc-i-continuation-20261001.md`。底座:`t24-secure-wiring-20261002.md`、`t24-route-wiring-20261002.md`。

## 1. 现状核查(前置六步结论)

- **已有(不重建)**:`opcUaSecureTransport.ts` 证书批(3/3 测试);订阅源 `security?: OpcUaSecurityConfig` 三分支客户端工厂;路由层 `resolveOpcUaSecurity` 扁平字段组装 + fail-closed 校验;模拟 server 安全变体 + `listSessionChannelSecurity`。
- **previewOpcUa 链路形态**:client 构造点 `dataIntegration.ts:382-387` 内联固定 `MessageSecurityMode.None + SecurityPolicy.None`;配置面为连接配置扁平原始值(`contracts/data.ts:46` `Record<string, string|number|boolean>`);nodeIds 取数据集 sourceKey(与持久订阅同口径);唯一调用方 `previewDatasetAttempt`(`:229`),其上 `previewDataset` 被 dataQuerySource/dashboardPublishedDataSource/dataPipelineService/dataReplay 四处消费。
- **真实缺口**:preview 链无 security 配置面(连接配置 `certificateManagerRootDir` 对 preview 无效);无 preview secure 端到端测试;`resolveOpcUaSecurity` 为路由私有,preview 同形复用需单一事实源。
- 基线实测:OPC UA 家族 + dataIntegration + mqtt 六文件 **62/62 全绿**(接线前)。

核查证据:`test-output/t24-preview-20261002/progress-01.json`、`vitest-baseline.log`。

## 2. 联动形态(三点)

### 2.1 单一事实源(`opcUaSubscriptionSource.ts`)

`resolveOpcUaSecurity` 自 `mqttIngestRoutes.ts` 上移为导出函数(与 `OpcUaSecurityConfig` 同址;该模块无静态 node-opcua 依赖,dataIntegration 静态导入零加载负担)。函数体与路由私有版逻辑逐位相同:无 `certificateManagerRootDir` 键 → `undefined`(零退化);键存在但空/非文本 → fail-closed 拒绝,绝不静默降级。`mqttIngestRoutes.ts` 改为导入,同名同义,既有 HTTP 校验测试原样通过。

### 2.2 preview 接线(`dataIntegration.ts` previewOpcUa)

```ts
const security = resolveOpcUaSecurity(connection.config);
const client = security
  ? await (async () => { /* 惰性 import createSignedOpcUaClient(Sign + Basic256Sha256) */ })()
  : OPCUAClient.create({ endpointMustExist: false, connectionStrategy: {...maxRetry: 1}, securityMode: None, securityPolicy: None });
```

- 有 security → `createSignedOpcUaClient`(客户端自签证书同 rootDir 复用),后续 connect/session/read 编排零改动;
- 无 security → 原 None 构造参数逐位不变;安全路径惰性 import,None 路径的模块加载面不变;
- 如实声明:连接编排语句因引入分支必然被触碰,但 None 分支的构造参数与联动前逐位相同,行为零变化(测试证明)。

### 2.3 测试形态真复用(`opcUaSimulatedServer.ts` 新测试支持模块)

`startSimulatedServer`(含 securityPolicies 安全变体)/`reserveFreePort`/`waitForCondition`/`sleep`/`SimulatedServer` 自 `opcUaSimulatedServer.test.ts` **逐字抽取**为支持模块,原测试文件改导入,preview 新测试消费同一形态(非复制)。唯一非逐字点:`server.engine.addressSpace` 可空的显式 fail-closed(tsc 检查非测试文件,测试文件被 tsconfig 排除)。

## 3. 栈实证(本批关键发现)

对 node-opcua 2.178 端点声明面的实证(`server.findMatchingEndpoints`):

| server 构造 | 实际声明端点 |
|---|---|
| 默认(无 securityPolicies) | None + Sign/SignAndEncrypt × Basic256Sha256/Aes128/Aes256 |
| `securityPolicies: ["None"]` | **仅 None\|None(真 None-only)** |
| `securityPolicies: ["Basic256Sha256"]` | **仍恒声明 None\|None** + Sign\|Basic256Sha256 + SignAndEncrypt\|Basic256Sha256 |

两个直接推论:

1. **底座/路由批的一处前提声明不实**:"server 仅声明 Basic256Sha256、透传断裂时 None 客户端被拒"不成立——node-opcua secure server 恒声明 None 端点,None 客户端永不被拒。**两批的验收结论不受影响**(其真实证据是 server 侧协商通道恒等断言,非端点声明面),相关测试注释已在本批纠正(仅注释,零行为变化)。
2. preview 连接是瞬态的(previewOpcUa 返回前 session 已关),持久订阅那类 server 侧通道观测在 preview 上恒为空。改用**不对称互锁设计**:`["None"]` server 是真 None-only 且 Sign 客户端必被拒("Cannot find an Endpoint matching security mode: SIGN policy: #Basic256Sha256",client 侧 findEndpoint 严格匹配)——拒绝信息点名请求策略,本身就是"配置键驱动签名客户端构造"的**正向证明**。

## 4. 验收结果

### 4.1 新增测试 4 例(`previewOpcUaSecurity.test.ts`)

| 用例 | 断言 |
|---|---|
| 无配置零退化 | None-only server + 连接无 rootDir → 预览成功取值(value 42/status Good);None-only 对 Sign 必拒(用例 3 实证),成功即证明无配置路径未被误切签名 |
| secure 端到端数据面 | Basic256Sha256 server + rootDir/applicationName → 预览成功取值(value 7/status Good),签名握手 + 读值可用 |
| secure 链路证明 | None-only server + rootDir → **必须被拒**,错误点名 SIGN + Basic256Sha256——拒绝本身即证明配置键真实驱动了签名客户端 |
| fail-closed | rootDir 空白 / applicationName 非文本 → 显式拒绝,先于连接尝试(端点为不可达占位地址,报错非 endpoint 类),绝不静默降级 None |

### 4.2 零退化证明链

- 行为级:用例 1(见上,互锁自证);
- 代码级:无配置分支 `OPCUAClient.create` 构造参数与联动前逐位相同,安全路径惰性 import 不改变 None 路径模块加载面;
- 既有测试级:基线 62 测试(证书批 3 + 订阅源 21 + 模拟 server 6 + dataIntegration 17 + mqttIngest 9 + 路由 6)全部逐位绿;
- 共享函数级:`resolveOpcUaSecurity` 上移后逻辑逐位不变,路由批 fail-closed 三子案原样通过。

### 4.3 最终回归与 tsc

- **8 文件 71/71 全绿**(66 = 62 既有 + 4 新增;dataReplay 下游旁证 5),证据 `vitest-final.log`;
- `apps/api` tsc 恰 2 错,均在 `packages/deep-engine/src/webgpu/hdrDisplayCanvas.ts`(16,23 / 29,30,ownerDocument)——域外既有错,与底座/路由批 tsc-after.log 逐字一致,本批文件零新增,证据 `tsc-after.log`;
- 同族排查:`SecurityPolicy.None` 全仓仅剩 preview/订阅两处无配置默认分支(设计内,非遗漏);`resolveOpcUaSecurity` 消费方恰两点(preview + 订阅路由);import 无环(dataIntegration → opcUaSubscriptionSource → 类型化 subscriptionRuntime/contracts;opcUaSecureTransport 仅安全路径惰性加载)。

## 5. T24 证书批还剩什么(诚实登记)

| 余项 | 说明 |
|---|---|
| SignAndEncrypt | 加密通道未覆盖(describe 已如实声明);证书吊销链同 |
| SubscriptionTransfer | 维持栈能力硬边界登记(node-opcua 2.178 无 TransferSubscriptions 服务实现),缺口报告对账替代 |
| 前端连接表单 | certificateManagerRootDir/applicationName 的 UI 输入项(preview 与持久订阅后端至此均已就绪,表单面属前端任务) |
| previewOpcUa 联动 | **本批关闭** |

## 6. 资产与纪律

- 未执行 commit/push/reset/clean/stash;四项用户资产(behaviorGraphDraft.ts、deliverables/、release-assets-v0.1.0/、release-staging-v0.1.0/)未触碰;`jc-i-continuation-20261001.md` 未改;未用 cargo。
- 本批变更文件:`apps/api/src/opcUaSubscriptionSource.ts`(+resolveOpcUaSecurity 导出)、`apps/api/src/mqttIngestRoutes.ts`(改共享导入)、`apps/api/src/dataIntegration.ts`(previewOpcUa security 分支)、`apps/api/src/opcUaSimulatedServer.ts`(新,测试支持模块)、`apps/api/src/opcUaSimulatedServer.test.ts`(改导入 + 注释纠正)、`apps/api/src/mqttIngestRoutes.test.ts`(注释纠正)、`apps/api/src/previewOpcUaSecurity.test.ts`(新,4 用例)。
- 证据:`test-output/t24-preview-20261002/`(progress-01/02/03.json、vitest-baseline.log、vitest-new-focus.log、vitest-final.log、tsc-after.log)。
