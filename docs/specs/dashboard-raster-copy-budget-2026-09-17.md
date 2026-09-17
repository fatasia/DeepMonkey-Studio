# 光栅冻结前的内存预算

正式 Dashboard 光栅编译此前先 `structuredClone` 再检查资源预算；TypedArray 切片会连同背后未使用的整个 ArrayBuffer 一起复制。小图片/字体视图也可能造成超出其声明字节数的内存占用。

冻结入口现在先统计全部资源实际 byteLength，超过64 MiB直接拒绝，再复制文档/元数据和各资源实际字节范围。像素返回入口先核对请求尺寸与RGBA长度，再复制实际像素范围；SHA-256、字体证据与快照隔离验证仍在复制后执行。

新测试覆盖：超预算在structuredClone之前拒绝、1 MiB backing buffer中的3字节资源只分配3字节、像素切片只分配4字节、原数组修改不污染冻结快照、资源/像素哈希不匹配继续拒绝、错误尺寸和像素长度在复制前拒绝。5项新增、13项内容编译与22项文字/数据回归通过。

这是字节分配范围的确定性验证，不是全流程峰值内存或帧率测量。不改视觉、资源合同、能力报告或64 MiB限额。

完整复验：`pnpm exec vitest run --config scripts/dashboard-raster.vitest.config.mjs` 23文件176项全部通过；设置 C2_NATIVE_EXECUTABLE、C2_FONT_PATH=微软雅黑、C2_FALLBACK_FONT_PATH=Arial，真实 Native producer 未跳过。Web typecheck、repository gate通过。首次类型检查发现并行标题测试的readonly赋值，修正后复跑通过；不将首次检查计作通过。

## Native producer 文件读取

`nativeTextRasterProcess.mjs` 的输入/输出读取改为按同一文件句柄的初始大小一次分配，64 KiB 分段读取，不再保留chunks并额外concat。中途截断、增长、mtime变化拒绝；分块前后继续检查取消，finally关闭句柄。内容SHA校验仍由上层执行，metadata不是内容真实性证明。

7项真实文件测试覆盖零字节/小文件/跨块、超额/目录、读取中截断/增长/改写/取消和预取消；与真实子进程取消/超时/篡改及图片producer一起35项通过。首轮ctime附加检查导致一次误拒；最终只检查内容相关大小/mtime，非内容metadata变动不作为拒绝依据。未测整个编译任务的峰值RSS。

## Producer 入口同族修复

图片/字体host在复制前检查取消、尺寸与资源总字节数。资源数据从metadata克隆中剥离，仅复制实际视图，再校验hash；后续转base64或解码复用这份冻结副本，不重复复制/校验。新增预取消（含不可克隆输入）、尺寸、字体总预算、图片切片断言；与真实子进程回归共31项通过。

两项实际 Native 字体/图片及KPI/表格/图表端到端producer测试另行显式通过，使用本机微软雅黑/Arial与debug播放器，未跳过；仓库门禁通过。
