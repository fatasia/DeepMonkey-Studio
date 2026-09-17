# Deep2D P2 兼容实验认证与淘汰报告

日期：2026-09-17。状态：首版认证报告；只覆盖已实测切片，不代表完整脚本、ECharts 或富文本生态兼容。

## 1. 判定

| 实验 | 当前结论 | 可进入下一切片 | 未认证/阻断 |
| --- | --- | --- | --- |
| X 兼容隔离 | **合同通过**：v1 封闭调用树、N0/X 隔离、硬预算、两阶段发布、输入/输出 hash | 独立受限进程与正式 IPC | 任意 JS、DOM、GPU、文件、网络、回调、源码求值 |
| ZRender Painter | **受限通过**：ECharts/ZRender 6.1.0、DOM-free SVG SSR、动态 bar rect 增量命令 | 相同版本、相同命令白名单的扩展实验 | formatter、图片、tooltip、动画、非 rect displayable、完整 ECharts |
| 中文富文本/IME | **离线轨迹通过**：N0 文档事务真源，N1 只消费成功 commit 快照 | X lane 对照、真实 Windows IME、像素证据 | HTML rich text、任意 formatter、脚本动画、未声明 bidi/fallback/换行 |

P2 当前证明的是三条可审计窄通道，不是兼容层。任一输入超出声明 profile，必须明确拒绝或保持上一 epoch，不得静默转成 N0 命令或伪造降级结果。

## 2. 固定证据

### 2.1 X 兼容隔离 v1

- 请求 schema：`1`；未知版本在求值前拒绝。
- request hash：`3949234e2c2c9f208af935a277dff1bd2f0dd4de504c147d5368ba1b0d480853`。
- output hash：`05dde4e6e1f84655ff6662dde75e43b04059cebea550d00aa95d16c06db31437`。
- 浮点 hash 视图采用 IEEE-754 64 位十六进制；资源身份稳定且唯一，pointer/emit 数值必须有限。
- 硬预算：CPU work units、常驻+输出内存、调用深度、消息条数、消息字节、wall-clock；宿主配置另有绝对上限。
- evaluate 只产候选；publish 重查 lane、开关、取消、deadline 和 epoch。失败不发布部分消息。
- 聚焦验证：6/6；Native clippy `-D warnings` 和 fmt 通过。

### 2.2 ZRender 动态 bar

- 依赖：真实 ECharts/ZRender `6.1.0`，无 DOM 的 SVG SSR。
- 输入 hash：`ae87c2244ad8391a0ff60df6733b384492be36ae3d9864c8ad9ce6f03a17a9c0`。
- 输出 hash：`bd879f1bb9133d78390306ed560df653b7af6dc4a7b7b46ed46d2ead76111011`。
- 允许：同一实例、stable-id rect upsert/remove、固定预算、错误时保留上一 epoch/hash。
- 确定性：10 个隔离实例输出 hash 一致；聚焦测试 10/10 与类型检查通过。

### 2.3 富文本/IME 轨迹

- fixture：`packages/deep-engine/fixtures/deep2d-rich-text-ime-trace-v1.json`。
- Native/N1 canonical digest：`c5c5ac85f2fb3c411aa75bf09baadd0f84beea9b6fb02b674b5563c0e4171b3d`。
- 覆盖：中文 composition/commit、combining、ZWJ emoji、簇光标、取消、越界拒绝、blur。
- N0 `TextDocumentV1/ImeSession` 是事务真源；N1 不观察 preedit，只消费成功 commit 后快照。
- Runtime Package TS hash 使用不同 domain 与 binary64 规则，不能伪称跨语言同 hash。
- 聚焦验证 1/1、`platform_text` 85/85；本批 Native 全量记录为 294/0/1 ignored。

## 3. 淘汰条件

出现任一情况立即停止扩大对应 profile：

1. 需要 DOM 仿真、浏览器布局或全局对象才能运行。
2. 每帧重建整图，或增量输出的 stable id/hash 不能跨实例复现。
3. 任意脚本、表达式、回调或自定义 JSON 穿透封闭调用/消息枚举。
4. 超时、取消、预算失败或旧 epoch 仍能发布部分结果。
5. formatter、HTML、图片或扩展通过字符串拼装绕过资源与安全边界。
6. 依赖升级后固定 fixture/hash 未显式更新并重新认证。

淘汰后保留 N0/N1 的原生能力与诊断，不增加兼容补丁或隐式 fallback。

## 4. 准入条件

- 每个新增 profile 单独冻结依赖版本、schema、输入/输出 hash、预算、timeout、失败码和上一 epoch 保持证据。
- 至少包含成功、损坏输入、预算耗尽、取消、超时、旧 epoch 和双跑确定性测试。
- X 真实执行必须先完成独立进程、IPC 消息上限、进程终止/崩溃隔离和无宿主对象证明。
- 富文本进入发布前补真实 Windows IME 与 cosmic-text 的 bidi/fallback/换行像素对照。
- HTML rich text、ECharts-GL 与任意扩展默认 blocked，必须各自重新认证，不能继承本报告结论。

## 5. 本轮未关闭项

- P2-01：独立受限进程、正式 IPC、崩溃/强制终止隔离。
- P2-02：formatter、图片、tooltip、动画、非 rect displayable。
- P2-03：异常/超时宿主轨迹、X lane 对照、真实 Windows IME、bidi/fallback/换行像素。
- 整体：P3 热同步与复用包 diff/watch/LKG 尚未开始；P2 报告完成不等于 Deep2D 收官。
