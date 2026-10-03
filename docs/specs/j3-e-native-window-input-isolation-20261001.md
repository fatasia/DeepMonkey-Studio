# J3-E 冻结窗口的输入隔离

## 现状核查

1. 检索 app/device_loss_probe_tests、window_events、selection、PlayerState 与未跟踪项：冻结相机和选择已断言；实际窗口仍向正常输入处理链转发鼠标/键盘。
2. 读取 PlayerView/PlayerState 和 NativeApp 生命周期合同：交互状态由CPU拥有，renderer重建必须保持；窗口probe没有授权用户输入改变冻结fixture。
3. Cargo沿固定winit/wgpu，已有DeviceId::dummy及合成鼠标输入；无需新依赖。
4. 真实消费：窗口startup首帧后可见；MouseInput调用selection::click，真实命中会重设view.target/distance。生产verification已有冻结输入白名单；本probe不用verification以保留普通产品首帧/恢复路径。
5. 当前J5 receipt evidence-20261001071520.json为30/32通过；Native retry日志实际selection opaque.near使目标从[0,0,0]变成[-1.1,.75,.75]、距离4变成1.9467081，随后相机保持断言失败。完整失败日志保留。旧窗口CPU合同/实际present/retry门已有。
6. 已读权威J3-E后继、窗口接线/恢复/驱动显存规格与续接台账，不能把冻结测试扩大成用户操作恢复验收。

已有（不重建）：真实NativeApp窗口、原handler、actual device.destroy/lost、重试、具名Presented、HDR身份与stale拒绝。

真实缺口：冻结附件probe未隔离外部输入，鼠标事件可以改变基线。只在test harness转发已登记的close/resize/scale/occluded/redraw事件，实际生产handler不改；前后相机/选择断言不放宽。新增实际鼠标移动/按下/释放/滚轮负控，确认它们没有改变冻结状态。生命周期与GPU仍由真实生产链执行。

原300行测试模块提取既有receipt写盘到已有window_timing序列化叶，公开入口、字段与文件名不变。复验具名Native窗口两fresh、完整suite与最终J5；不得把一次失败后的单腿成功称作新全链成功。

## 实际复验

`test-output/jc-i-20261001-window-input-isolation.log` 的完整窗口 suite 已通过，currentRun=true：四种 Native 窗口路径各两 fresh，并执行 Web 实际回退、成功和首帧拒绝候选路径。输入负控为真实 probe 的鼠标移动、按下、释放、滚轮四事件；生产窗口 handler 未修改。引擎 source-size 新增输入叶后 failures=0；WASM 已按新的 Native 测试源指纹重建。最终统一 J5 待当前 I16/J3 新批次完成后执行，旧 30/32 失败仍保留。
