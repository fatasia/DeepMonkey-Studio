# I-C26 编译诊断公共快照与真实等待量化

为调用方开放已有PBR编译账本的按需只读快照，不改变管线集合、用户模式或每帧执行。

## 现状核查

1. 已检索packages/apps与未跟踪状态：PipelineCompileCache、PbrPipelineSet、bootstrap关键子集/背景队列与预热持久化已存在；PbrRenderer未公开清单。
2. 已读PipelineCompileRecord、PbrPipelineBootstrapOptions、PbrRendererOptions及contracts场景合同：编译墙钟、GPU pass计时和首有效帧是不同口径，已有字段够用，不新增场景字段。
3. 已查package/Cargo：Vitest、esbuild、Playwright/Chrome/WebGPU与现有pipeline设施可复用；本刀无依赖、Rust或WGSL变更。
4. 实际消费是pipelines.createPipelinesBuild→device cache→PbrPipelineSet→openPbrRenderer预热落盘；公共入口只暴露渲染遥测，清单仍留内部。
5. 已查pipelineCache/integration、pipelineWarmup/queue、bootstrap与deformation实机probe。cache真实创建记录有4096条上限；命中记录直接push，不执行同一预算截断。
6. 已读本日剩余表、权威清单、handoff及recovery；C26已有90be13af/5fd40e6b范围不重做。旧条件触发描述不能覆盖已完成实现；本刀补按需诊断与实机等待证据。

已有（不重建）：指纹/设备隔离/并发去重/失败失效、首帧关键队列、后台编译、预热持久化、注入时钟。

真实缺口：公共诊断入口、与活log隔离的只读快照、命中路径日志预算，以及真实编译等待与复用的量化。

## 最小实施与验证

已接入 `PbrRenderer.getPipelineCompileRecords()`，独立helper返回冻结数组与逐记录冻结副本；现有记录六字段均为string/number/boolean，无嵌套或GPU对象引用。读取时才分配，不在render循环轮询，不drain内部账本。复用device缓存，设备重建自然隔离。命中/成功/失败记录走同一4096条上限，缓存/编译promise语义保持。pbrRenderer只增加import与两行方法；其已有体量债保持原排程。

CPU测试覆盖未结算、成功、命中、失败重试、快照冻结/隔离、设备隔离与预算。真实GPU沿用DeviceSession/ForwardPlusPbrLightingBindings/createPbrPipelineSet，分别记录criticalReady、ready及同设备同布局set复用；第二次返回同set、无新增编译记录。直接重复createPipelinesBuild会创建新GPU布局/module身份，不能据此假设PSO缓存命中；这里使用正在生产消费的set factory。另用实际PbrRenderer公共API读取清单并验证真实首帧。首帧等待和出图分开报告；预热计划仅决定顺序，不保证不同设备/驱动收益。GPU由主线串行执行，未验时不写通过。

CPU聚焦5文件31测通过；lab类型检查、runner语法与diff通过。4100次命中后仅保留最后4096条，原快照保持原长度和数值；外部修改冻结记录或数组均被拒绝。计时实现未改，pipelineCache既有runtimePurity performance访问仍属于已列工程债，本刀未新增时钟或扩大allowlist。

运行：仓根 `node scripts/i-c26-pipeline-compile.mjs`。主线实际GPU两轮通过，`passed=true`、`structuralStable=true`；各轮公共API读取19条冻结记录，实际首帧非零，同设备同布局复用返回同set、无新增编译，资源残留0。两轮cold critical/全部等待分别67.9/1535ms、82.9/413.6ms；各轮36条编译、17条在release后完成。完整观察值见 `test-output/i-series-0930/pipeline-compile/evidence.json`。截图仅深色1920×1080，16×16数值首帧fixture保持。编译墙钟是观察值，不要求两轮字节相同，不将编译耗时总和当墙钟或GPU帧时收益。本刀公共诊断/预算与实机等待范围完成，源码锁释放主线收录。

I系列由本子智能体独占推进，不另派子智能体。C26实机等待期间继续C25真实Play路径核查。
