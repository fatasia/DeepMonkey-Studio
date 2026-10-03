# T24 安全模式保真与失败关闭复核（2026-10-02）

## 现状核查

1. 全仓及未跟踪文件检索：`resolveOpcUaSecurity`、`createSignedOpcUaClient`、`messageSecurityMode`、`securityMode` 的产品消费者恰为持久订阅和数据预览；前端配置写入位于 `DataCenterForms.tsx`。工作树已有大量并行成果，不覆盖、不提交、不清理。
2. 契约：`contracts/src/data.ts` 的 `DataConnectionRecord.config` 为扁平 `Record<string, string | number | boolean>`；`OpcUaSecurityConfig` 与消息安全模式已有，不另建公共合同。
3. 依赖：API 已固定 node-opcua-client/certificate-manager 2.178.0、pki 6.20.0；复用 TypeScript、Vitest、模拟 server，不添加依赖。
4. 消费方：HTTP 配置经 `mqttIngestRoutes` 进入订阅源；`dataIntegration.previewOpcUa` 另行调用安全客户端；前端保存会组装扁平配置。不能只测直接构造客户端。
5. 测试：已有 secureTransport 6 例、preview 4 例、HTTP 路由与订阅源测试；直接客户端使用正确的驼峰枚举，未覆盖扁平配置到客户端之间的归一化。表单仅 SSR 检查，未验证实际保存与非法模式。
6. 规格：读 10-01 handoff、61 行估时表、root 续作账本与 t24-sign-encrypt-revocation/preview/route/security 规格。仓库中 `bim-studio/AGENTS.md` 当前不存在，记录这一事实，按父工作区约束及长期工程/测试/设计门禁执行。

**已有（不重建）**：证书生成、Sign/SignAndEncrypt 直接客户端、CRL 库级 server 拒绝夹具、扁平安全配置、订阅与预览、安全模式下拉框。

**真实缺口**：
- P1：配置 `signAndEncrypt` 归一成 `signandencrypt` 并以类型断言伪装合法，客户端只比较驼峰枚举，因此实际退回 Sign。
- P1：预览安全分支未传 `messageSecurityMode`，配置正确仍退回 Sign。
- P1：表单非法模式被删除配置键，后端看到缺省值而非非法值，静默降级；显式安全模式无证书目录时后端也直接返回 None。
- P2：证书生成使用临时 CertificateManager 后未释放 watcher；必须在成功/失败两条路径结束释放。
- 声明错误：前批“全链关闭”及“吊销链已消费”表述超出证据；CRL 目前是测试 server 自管 CM 的拒绝证明，不能冒充产品客户端验证远端证书的闭环。

## 最小方案与边界

- 保持已存在合同与默认行为：无安全键仍为 None；仅目录仍默认为 Sign；显式模式标准化回 `sign` / `signAndEncrypt`，绝不保留全小写伪值。
- 显式模式缺目录、非法文本/非文本、运行时非法枚举均在任何连接或证书 IO 前拒绝；预览与订阅使用同一解析结果。
- 表单非法配置保存必须给人读错误，不删键降级；使用现有控件与 base.css 令牌，不改布局/风格。
- 首先补可失败的配置与端到端反例，记录修前结果；修后验证 HTTP→订阅的服务端真实安全模式、预览端点拒绝模式和读值、原 Sign/None、保存往返、证书内容复用与 watcher 释放。
- 新测试叶小于 300 行；不做拆分大文件、不碰用户资产、Native/Cargo/GPU 或另一线路着色器。

## 结果与证据

- 修前模式反例 `test-output/t24-security-fidelity-20261002/before-mode.json`：19 测，12 失败；覆盖错误大小写归一、无目录显式模式、运行时非法枚举、证书 manager 泄漏。
- 修复：归一化恢复驼峰标准枚举；安全传输在证书 IO 前拒绝非法枚举（含空串/null/false）；预览透传同一模式；显式模式无目录拒绝而非 None；临时 CertificateManager 禁 watcher 并始终 finally dispose；表单非法模式明确选项、可操作错误、不删除键降级，合法模式大小写回读归一。
- 正式 API 六文件 **73/73**；Web 表单和相邻呈现 **11/11**；API/Web 全量 tsc 均 **exit 0**。证据 `final-api.json`、`final-web.json`、`final-*-typecheck.log`。
- 端到端：原 HTTP 路由例两腿化，不配置模式→服务端实际 Sign；配置加密→服务端实际 SignAndEncrypt，数据44进入 DataEventBus，stop 正常。预览服务端 `session_activated` 捕获真正短暂协商通道，读值73后session关闭，证明选择加密而非仅“读到数据”。非法模式/无目录均在连接前拒绝，状态无残留。
- 官方 IAB 实际产品交互：登录隔离项目→OPC UA表单→填目录→选择signAndEncrypt→保存→完整刷新→重开后模式仍选中；HTTP读取确认持久化键未变。注入非法模式于仅本批隔离记录→重开→保存被明确拒绝；改回加密→保存成功→旧错误清除；证据 `browser-summary.json`、`browser-uC5oIh/browser-persisted-encrypted.json`、`browser-recovered-encrypted.json`。
- 视觉实测：1920×1080深色首轮、1280×900深色重开/错误态、1280浅色恢复均截图。布局沿既有可滚动表单、控件/提示未压盖；没有新增CSS或hardcode令牌。截图 `01-dark-encrypted-1920.png`、`02-dark-reloaded-1280.png`、`03-invalid-mode-error.png`、`04-light-recovered-1280.png`。

### 诚实边界与不能关闭的范围

- 一次 concurrent Vite HMR（App更新）期间出现 `STUDIO_RENDER_FAILED`；刷新后同非法记录可编辑、保存正确拒绝。尚未隔离精确触发，不能把它隐去或宣称浏览器控制台0。
- 浅色截图顶部断连提示来自自建隔离服务25分钟到期（服务脚本明确计时关闭），保留真实截图不删告警；不记为连接UI断网修复。
- 未跑480px/键盘完整遍历与全部权限/取消矩阵。UI全面三门禁未过，不能凭两截图给十维虚高分；本批闭的是安全模式保真与错误态，不闭E2全页验收。
- **远端CA/CRL信任未接产品客户端配置**；已有CA/吊销例是隔离测试server拒绝客户端的证明，不能冒充应用连接远端时验证服务器证书闭环。产品支持声明已收窄为实证边界。OCSP与SubscriptionTransfer保持既有栈边界。
- 前批“T24全链关闭”暂撤销。T24为61行列表中的历史核查，不因本修复或撤销另增减61整项；后继产品信任配置仍在T24原范围。

### 门禁评分（本批范围，以证据为准）

工程十维：理解/方案/复用/实现/边界/错误/验证/性能/可维护/诚实分别9/9/9/9/9/9/9/9/9/9。依据：先核六步与红12例、无公共合同/依赖新建、连接前校验、真实协商正负控、证书释放、相邻族全绿与逐文件diff。

测试八维：覆盖9、真实性9、缺陷产出9、同族9、证据9、分级9、边界9、恢复回归9（仅本批安全保真范围；跨产品用户验收未覆盖轴明确不计通过）。视觉十维不整体发证：响应式/主题7（480未测），反馈8（准确等待计时/控制台未覆盖），其余仅现状检查不编分；因此广义视觉闭环仍未过。
