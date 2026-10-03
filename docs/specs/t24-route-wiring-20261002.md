# T24 路由层透传报告(2026-10-02)

> 任务:把订阅源已就绪的 security 能力(Sign + Basic256Sha256)经路由层透传给 HTTP/API 用户——`OpcUaIngestConfig` 增可选 security 字段,`startPersistentOpcUa` 透传,路由层从连接配置组装并校验。行内小批,不改 `jc-i-continuation-20261001.md`。底座:`t24-secure-wiring-20261002.md`。

## 1. 现状核查(前置六步结论)

- **已有(不重建)**:订阅源 `security?: OpcUaSecurityConfig` + 三分支客户端工厂(注入优先 > security 签名 > None 匿名);`createSignedOpcUaClient`;模拟 server 安全变体 + `listSessionChannelSecurity`;HTTP 全链路测试形态(`mqttIngestRoutes.test.ts` 内嵌 server 用例)。
- **配置流盘点**:HTTP `POST .../ingest/persistent/start`(`mqttIngestRoutes.ts:66`)→ `buildOpcUaIngestConfig`(`:146`,从 `connection.config` 组装)→ `supervisor.startPersistentOpcUa`(`mqttIngest.ts:306`,sourceFactory 逐字段展开)→ `createOpcUaSubscriptionSource`。三处中后两处无 security。
- **硬约束**:`DataConnectionRecord.config` 是 `Record<string, string|number|boolean>`(`contracts/data.ts:46`)——扁平原始值,无法直接嵌套 security 对象;HTTP 面用扁平字段 `certificateManagerRootDir`(+可选 `applicationName`),路由层组装。
- **消费方**:`buildOpcUaIngestConfig` 与 `startPersistentOpcUa` 的生产调用方均唯一(HTTP 路由);`describeOpcUaSubscriptionSupport` 零生产调用方(仅测试),securityEnabled 无需联动。
- 基线实测:mqttIngest + mqttIngestRoutes + opcUaSubscriptionSource 三文件 **34/34 绿**(改动前)。

核查证据:`test-output/t24-route-wiring-20261002/progress-01.json`。

## 2. 透传形态(纯字段,三落点)

1. **合同**(`opcUaSubscriptionSource.ts`):`OpcUaIngestConfig += security?: OpcUaSecurityConfig`(复用底座既有接口,不新增类型)。
2. **透传**(`mqttIngest.ts:321`):sourceFactory 展开 `...(config.security ? { security: config.security } : {})`——一行条件展开,订阅源零改动。
3. **组装 + 校验**(`mqttIngestRoutes.ts` `resolveOpcUaSecurity`):
   - 连接配置**无** `certificateManagerRootDir` 键 → 返回 `undefined`,config 输出与透传前**逐位相同**(None 匿名路径零退化);
   - 键存在即视为启用签名通道:空串/纯空白/非文本 → **fail-closed 拒绝**(throw → 既有 catch → 502 可行动信息),绝不静默降级回 None——静默降级会掩盖用户的安全意图;
   - `applicationName` 可选,同口径校验(空/非文本拒绝);缺省由传输批落 `bim-studio-client`;
   - 路径规整:`trim()` + `path.normalize()`(统一分隔符/折叠冗余段),**不绝对化**——相对路径语义保持宿主进程。

校验错误落 502 的口径与该路由既有配置错误一致(`connectorUrl`/`requiredSource` 同在 try 内,连接配置问题历来 502 + ok:false)。

## 3. 验收结果

### 3.1 新增测试 2 例(`mqttIngestRoutes.test.ts`)

| 用例 | 断言 |
|---|---|
| 签名通道配置校验(缺字段拒绝) | rootDir 纯空白 / 非文本(数字)/ applicationName 纯空白 三子案均 **502 + ok:false**,消息分别含 `certificateManagerRootDir` / `applicationName`;报错先于连接尝试(端点是假地址,消息不含"endpoint 不可达"即证明校验前置);事后 persistent/status 均 `status: null`(无残留会话) |
| 签名通道透传(HTTP 端到端,1604ms) | 模拟 server **仅声明 Basic256Sha256**(透传断裂则 None 客户端被拒,用例自证失败);连接配置带 `certificateManagerRootDir` + `applicationName` → **202 healthy**;server 侧真实协商通道 `securityMode === Sign` 且 `securityPolicy === Basic256Sha256`(恒等断言,非客户端请求参数);值变更 44 经签名通道进 DataEventBus(`source: opcua/plc-1`);stop 正常 |

### 3.2 零退化证明

- 基线(改动前):三文件 **34/34** 绿;底座五文件 43/43 绿;
- 改动后:同五文件 **45/45** 绿(43 既有逐位绿 + 2 新增),证据 `vitest-final.log`;
- 无字段路径行为不变:既有 fail-closed 用例(无 security 配置)仍报"OPC UA endpoint 不可达"502——无字段路径走到 supervisor 且行为与透传前一致;
- 同族排查:全仓 grep 确认 `buildOpcUaIngestConfig` 是 `OpcUaIngestConfig` 唯一组装点,无遗漏组装面;`describeOpcUaSubscriptionSupport` 无生产调用方,无需联动。

### 3.3 tsc

`apps/api` 恰 2 错,均在 `packages/deep-engine/src/webgpu/hdrDisplayCanvas.ts`(16,23 / 29,30,ownerDocument)——域外既有错,与底座报告逐字一致,本批文件零新增。证据 `tsc-after.log`。

## 4. T24 行还剩什么(诚实登记)

| 余项 | 说明 |
|---|---|
| SignAndEncrypt | 加密通道未覆盖(底座 describe 已如实声明);证书吊销链同 |
| 编辑器/前端连接表单 | 连接配置 UI 尚无 certificateManagerRootDir/applicationName 输入项——HTTP API 已可配,表单面属前端任务 |
| previewOpcUa | 其 None 固定口径仍未联动(独立子项,底座登记延续) |
| SubscriptionTransfer | 维持栈能力硬边界登记(node-opcua 2.178 无该服务实现) |

## 5. 资产与纪律

- 未执行 commit/push/reset/clean/stash;四项用户资产未触碰;`jc-i-continuation-20261001.md` 未改;未用 cargo。
- 变更文件:`apps/api/src/opcUaSubscriptionSource.ts`(+3)、`apps/api/src/mqttIngest.ts`(+1)、`apps/api/src/mqttIngestRoutes.ts`(+38)、`apps/api/src/mqttIngestRoutes.test.ts`(+111);新增测试 2 例;证据与报告如上。
