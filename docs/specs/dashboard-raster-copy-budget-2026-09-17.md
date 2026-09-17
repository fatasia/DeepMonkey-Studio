# 光栅冻结前的内存预算

正式 Dashboard 光栅编译此前先 `structuredClone` 再检查资源预算；TypedArray 切片会连同背后未使用的整个 ArrayBuffer 一起复制。小图片/字体视图也可能造成超出其声明字节数的内存占用。

冻结入口现在先统计全部资源实际 byteLength，超过64 MiB直接拒绝，再复制文档/元数据和各资源实际字节范围。像素返回入口先核对请求尺寸与RGBA长度，再复制实际像素范围；SHA-256、字体证据与快照隔离验证仍在复制后执行。

新测试覆盖：超预算在structuredClone之前拒绝、1 MiB backing buffer中的3字节资源只分配3字节、像素切片只分配4字节、原数组修改不污染冻结快照、资源/像素哈希不匹配继续拒绝、错误尺寸和像素长度在复制前拒绝。5项新增、13项内容编译与22项文字/数据回归通过。

这是字节分配范围的确定性验证，不是全流程峰值内存或帧率测量。不改视觉、资源合同、能力报告或64 MiB限额。

完整复验：`pnpm exec vitest run --config scripts/dashboard-raster.vitest.config.mjs` 23文件176项全部通过；设置 C2_NATIVE_EXECUTABLE、C2_FONT_PATH=微软雅黑、C2_FALLBACK_FONT_PATH=Arial，真实 Native producer 未跳过。Web typecheck、repository gate通过。首次类型检查发现并行标题测试的readonly赋值，修正后复跑通过；不将首次检查计作通过。
