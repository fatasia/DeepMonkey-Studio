# T24 SignAndEncrypt + 证书吊销链(2026-10-02,主线程批)

## 现状核查(先读后写)

- 已有(不重建):`opcUaSecureTransport.ts`(Sign + Basic256Sha256 客户端证书构造,pki 6.20 CertificateManager)、`opcUaSubscriptionSource.resolveOpcUaSecurity`(单一事实源,扁平连接配置→security 组装,fail-closed)、路由整包透传(connection.config 全量进 resolveOpcUaSecurity,新键自动流过,路由层零改动)、`opcUaSimulatedServer` 共享 harness(Sign 变体+listSessionChannelSecurity server 侧真实协商观测)、`describeOpcUaSubscriptionSupport` 条件声明。
- 真实缺口:①客户端消息安全模式锁死 Sign(SignAndEncrypt 未覆盖);②CA 链/吊销链零覆盖(describe 如实声明"未覆盖");③前端表单无 securityMode 输入项(后端先行的声明边界)。

## 实现

1. **opcUaSecureTransport.ts**:`OpcUaMessageSecurityMode = "sign" | "signAndEncrypt"` 类型 + `messageSecurityMode` 可选选项(缺省 sign=既有行为逐位保持);`createSignedOpcUaClient` 按模式映射 `MessageSecurityMode.Sign / SignAndEncrypt`,policy 恒 Basic256Sha256。
2. **opcUaSubscriptionSource.ts**:`OpcUaSecurityConfig.messageSecurityMode` 可选;`resolveOpcUaSecurity` 解析扁平键 `securityMode`(大小写不敏感,归一小写;非法值 fail-closed 显式抛错,拒绝静默降级);start() 安全路径透传;describe securityEnabled 分支更新为"Basic256Sha256 + sign|signAndEncrypt 可选 + CA 链/吊销链已覆盖"。
3. **opcUaSimulatedServer.ts harness**:`startSimulatedServer` 增可选 `serverCertificateManager` 注入(类型引自 node-opcua-certificate-manager,编译期擦除)——吊销链验收用自管严格 CM(automaticallyAcceptUnknownCertificate:false)。
4. 类型引用全部 `import type`,订阅源"模块级零 node-opcua 运行时依赖"口径保持(安全路径惰性 import 不变)。

## 吊销链测试(三腿,opcUaSecureTransport.test.ts)

CA(pki CertificateAuthority)→ CSR(clientCM.createCertificateRequest,私钥落 own/private)→ CA 签发(signCertificateRequest)→ server 侧 OPCUACertificateManager 严格模式 + addIssuer(CA DER,validate,trust)+ CRL 安装至 issuers/crl + reloadCertificates:

- **SignAndEncrypt e2e**:默认 CM server + signAndEncrypt 客户端 → 读写数据 + server 侧通道观测恒等 `{SignAndEncrypt, Basic256Sha256}`(非客户端请求参数回读)。
- **合法腿**:CA 签发未吊销证书,CM 层 `verifyCertificate(DER,{acceptCertificateWithValidIssuerChain:true})`=Good → 端到端连接成功 + SignAndEncrypt 通道建立(链信任正向证明)。
- **拒绝腿**:`ca.revokeCertificate(cert,{reason:"keyCompromise"})` → 重装 CRL → CM 层=**BadCertificateRevoked** → 端到端连接在 openSecureChannel 被拒(server 日志实证 `BadSecurityChecksFailed{description:'certificate invalid'}`)且 `listSessionChannelSecurity()` 恒空(fail-closed 零通道)。

## 栈实证(对抗式探针发现,防复发)

1. **`OPCUACertificateManager({location})` 静默忽略 location 并回落全局用户 PKI 目录**(`%APPDATA%/node-opcua-default-nodejs/Config`)——目录选项名是 **`rootFolder`**(getDefaultCertificateManager 同款)。探针实证 issuersCrlFolder 指向全局;测试污染已外科手术清理(仅删探针写入的 T24 CA 条目与 CRL,保留既有测试证书)。**任何注入 OPCUACertificateManager 的代码必须传 rootFolder。**
2. pki `verifyCertificate` 直调默认不信任"不在 store 里的链签证书"——node-opcua 真实路径带 `{acceptCertificateWithValidIssuerChain:true}`;缺该选项时合法链=BadCertificateUntrusted(探针实证),直调校验必须带它。
3. `automaticallyAcceptUnknownCertificate` 默认 false(node-opcua 默认 server CM 工厂显式传 true)——吊销拒绝的语义前提是自管 CM 关闭 auto-accept。
4. `disableFileWatchers:true` 供测试批量建 CM(chokidar watcher 耗尽 libuv 线程池的官方逃生口);CM 用毕 `dispose()`(否则 watcher 挂进程)。
5. openssl 输出 PEM,pki 校验 API 吃 DER:`new X509Certificate(pem).raw`(node:crypto 内建,零新依赖)。
6. openssl 探到系统 3.2.4(Git mingw64),pki 全链(CA/CSR/签发/吊销/CRL)在本机可用。

## 测试证据

- `opcUaSecureTransport.test.ts` **6/6**(原 3 + SignAndEncrypt e2e + 吊销链合法/拒绝两腿);server 拒绝日志:BadSecurityChecksFailed @ OpenSecureChannelRequest。
- T24 全族回归 **4 文件 37/37 全绿**(subscriptionSource/simulatedServer/previewSecurity/secureTransport);describe 声明断言按扩面后合同同步(能力真变,断言随合同,非放宽)。
- apps/api 全量 tsc **0 错**(含此前 hdrDisplayCanvas 既有债修复后基线)。
- 全局 PKI store 终查:issuers/certs 空、无 T24 CA 残留(rootFolder 修正后零再污染)。

## 如实边界

- 吊销链覆盖 **CRL 静态分发**口径;OCSP 在线状态查询未覆盖(node-opcua 2.178 栈内无 responder,声明边界同旧)。
- 用户令牌安全仍匿名口径(与订阅源无 user 配置一致,未变)。
- 前端表单 securityMode 输入项未做(后端已接受扁平键 securityMode;UI 输入项属 DataCenterForms 域,随下批)。
- SubscriptionTransfer 维持栈硬边界(node-opcua TransferSubscriptions 零实现,既有裁定不变)。
- 不 commit 不 push;禁 cargo 达成。
