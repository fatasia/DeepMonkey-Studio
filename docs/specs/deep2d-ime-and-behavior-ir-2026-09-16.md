# P1-20 IME 事务与 P1-21 行为 IR 命令总线(2026-09-16)

承接 [Deep2D 剩余任务总表](deep2d-remaining-tasks-2026-09-16.md) P1-20、P1-21。
两项都是**合同与状态机**切片,无 GPU/浏览器产出,纯 CPU 逻辑。

## P1-20:IME 事务会话

### 交付

`src/platform_text/ime_session.rs`:`ImeSession` —— 把既有的三个 helper
(`text_edit::TextEditState`、`ime::CompositionState`、`ime_winit::WinitImeAdapter`)
收成**事务化会话**,并接到 P1-18 的 `TextDocumentV1`。

复用而非重建:`CompositionState` / `WinitImeAdapter` 继续负责与 OS 事件对接,
本模块负责**事务语义**。

### 五条不变量(各有测试)

1. **组合期文档逐字节不变**:preedit 只存在于会话内;`update_preedit` 与取消
   都不触碰文档与 revision;
2. **提交经单一编辑路径**:走 `replace_clusters`,产出 `TextChange`;
3. **切焦点必取消在途组合**:`blur()` 丢弃 preedit,不得遗留进文档;
4. **撤销按事务粒度**:一次提交是一条可撤销编辑,撤销本身也推进 revision
   (让缓存失效),redo 栈被新提交打断;
5. **删除按簇**:emoji(4 字节 1 簇)与组合序列整体删除,绝不按字节或 UTF-16 切开。

### 实测发现的缺陷(测试抓到)

初版 `HistoryEntry` 只记一个簇区间,用于撤销与重做两侧。测试
`redo_restores_the_committed_text` 立刻失败:`replace range 0..2 out of bounds`。

根因:**撤销与重做需要的区间口径不同**。提交把 `insert_at` 处的空区间变成 `[insert_at, insert_at+n)`;
撤销要在这个 n 簇区间上写回空串,而重做要在**空的** `insert_at` 重新插入。
只记一个区间,重做就会在「撤销后的文档」上越界。

修复:分别记录 `insert_at` + `inserted_clusters` + `is_insert`,并保留
`replaced` / `inserted` 两份文本;撤销与重做按 `is_insert` 选择区间口径。
同时对区间做当前文档的夹取,使更早形态的历史条目也不会越界。

### 诚实边界

- **bidi/RTL 重排未实现**——需要已批准的 shaping 库,不假装支持;
- **DPI 候选窗未实现**:候选窗由宿主窗口层绘制,本模块只给 caret 锚点
  (簇索引 + 调用方量测的矩形),不管理 DPI,不声称 OS 级验收;
- **未接产品窗口事件循环**:全部逻辑由注入事件驱动单测,接线归产品焦点层。

## P1-21:N0 受限行为 IR 与命令总线

### 交付

`src/behavior_ir.rs`:`BehaviorCommand`(封闭枚举载荷)+ `CommandBus<T: BehaviorTarget>`
+ `HostCapabilities` + `CommandBudget` + `CommandCounters`。

### 与既有 ChartAction 的边界(重要)

`ChartAction` 是**图表专用**的具体语义;本模块是**通用容器**:管合同机制
(身份、幂等、CAS、取消、能力门控、预算、可观测),不定义动作语义——
语义由宿主经 `BehaviorTarget` 注入(与 `chart::data_source` 的 `Transport` 注入同一范式)。

### N0 铁律的落实

**任意 JS / DOM / 脚本不得进入此处。** 具体做法:

- `BehaviorCommand` 是**封闭枚举**,不是 `serde_json::Value`;
- 属性值用闭合的 `Scalar`(Number/Bool/Index),**刻意不含字符串**——
  字符串会是「用数据当代码」的后门;
- 属性名是闭合的 `BehaviorProperty` 枚举,不是任意字符串;
- 能力缺失时命令被**拒绝**,不做降级执行。

### 两阶段提交(为什么必须如此)

任务要求「异步取消」。若 `submit` 即生效,「取消」只能是事后补偿,且会与已发布状态纠缠。
因此拆成两阶段,得到几条可测硬语义:

| 语义 | 落实方式 |
| --- | --- |
| 幂等 | 幂等键在 **submit** 时判重与消耗,重复投递不进第二次在途 |
| CAS | `expected_revision` 落后即拒;**结算时再核对一次**,防在途期间被抢先推进 |
| 取消 | 取消后 `settle` 返回 `Cancelled`(与「从未提交」的 `NotInFlight` 区分) |
| 预算 | 在途数/超时上限硬拒;取消释放在途额度;幂等键与取消记忆均有界且**有损**(计数可见) |

时间由调用方注入 `now_ms`(与 `data_source` 同范式):无墙钟、无线程、零真实 IO。

### 自查发现的语义问题(已修)

初版 `settle` 在目标拒绝应用时复用了 `NotInFlight` —— 混淆了「不在途」与
「应用失败」两种不同原因,调用方无法判断是否需要告警。新增 `ApplyFailed { reason }`
并透传目标说明;命令仍出在途以避免重复应用,revision 不推进。

另外补上「已取消」集合:二者都无在途记录,若不区分,宿主无法识别
「主动作废」与「调用方 bug」。该集合同样有界且有损(计入 `cancel_memory_forgotten`)。

### 验证

`behavior_ir_tests.rs` 20 项,分六组合同(身份/幂等/CAS/取消/能力/预算)+ 对抗式自查
(应用失败区分、非法载荷四种、invocation 复用、保留值 0、有损记忆、计数器自洽、
一次结算使更早命令过期)。

## 合并验证

| 检查 | 结果 |
| --- | --- |
| `cargo check --all-targets` | 0 warning |
| 四项新切片测试 | P1-18 16 + P1-19 8 + P1-20 16 + P1-21 20 = **60 项** |
| `cargo test --lib` | 204 通过 / 0 失败 |
| 源码体量门禁 | 4348 文件通过(新文件最大 588 行 < 800 线) |

## 诚实边界汇总

- P1-20 的 RTL/bidi 与 DPI 候选窗、P1-21 的真实异步与签名扩展,均已显式排除并记录;
- P1-19 未内嵌字体(许可未决)、未做子集化、未做跨机器实测比对;
- 三项均**未接产品路径**(无宿主消费方),也未做浏览器/GPU 验证——纯 CPU 合同切片。