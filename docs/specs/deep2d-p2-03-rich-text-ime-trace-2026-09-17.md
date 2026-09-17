# Deep2D P2-03 中文富文本输入实验：首个离线轨迹

日期：2026-09-17  
状态：首个最小可执行切片完成，P2-03 未完成

## 本切片

新增共享夹具 `packages/deep-engine/fixtures/deep2d-rich-text-ime-trace-v1.json`，用同一条离线事件轨迹覆盖：

- 中文拼音 preedit 到“运行”的单次事务提交；
- combining acute 与前一拉丁字母重组后，字素簇数量不虚增；
- `👩‍🔧` ZWJ emoji 从中间 preedit 到完整提交始终按一个字素簇处理；
- 光标簇位置与注入的离线 advance 量测；
- 取消组合、越界光标拒绝、失焦，均保持已提交文档与 revision；
- 每次 commit 后把 `TextDocumentV1` 快照投影给现有 N1 rich-text adapter，逐字对拍文本命令。

`ImeSession` / `TextDocumentV1` 是 N0 事务真源。preedit 仅存在于 session，N1 不接收 composition 事件；只有 commit 成功后的不可变文档快照才进入 N1。测试认证平台名固定为 `p2-03-offline-test`，不进入产品认证台账。

夹具按 Native/N1 canonical JSON 口径计算的 SHA-256 固定为
`c5c5ac85f2fb3c411aa75bf09baadd0f84beea9b6fb02b674b5563c0e4171b3d`；测试直接复用 N1
摘要实现对拍，输入改动必须显式更新证据，不能静默改变实验分母。它不冒充 Runtime Package
带域前缀、binary64 数字编码的另一套哈希口径。

## 明确未覆盖

- 未接 Windows TSF/winit 的真实候选窗、键盘布局、DPI 或 OS IME，因此不宣称 Native IME 验收完成；
- 未运行 X lane、JS、ZRender 或 ECharts；
- 未执行 formatter 与动画；
- 未注入超时，现有 `ImeSession` 是同步事务状态机；
- 离线 advance 只验证簇边界与光标累计，不代替 cosmic-text shaping、bidi、fallback 和换行像素验收。

后续以同一 fixture schema 增加 formatter/动画/异常超时的宿主轨迹，并在真实 Windows 输入与 N0/N1/X 对照证据齐全后再关闭 P2-03。
