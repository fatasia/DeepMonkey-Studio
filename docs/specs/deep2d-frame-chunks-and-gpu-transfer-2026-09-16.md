# 几何 chunk/view ABI(P1-05 第一批)与 GPU 传输策略评估(P1-06)

日期:2026-09-16 凌晨(第三轮子代理切片,主线程复核)。

## P1-05 有界 chunk/view ABI(第一批)

`ChartGeometryFrame` 内存结构重组:每系列命令/资源/命中索引改为三个 Arc 持有,扁平 `Deep2dDisplayList` 变为 `OnceLock` 惰性视图(首读物化一次,永不重建);线格式与 `display_list()` 签名不变,消费方零改动。

- **收益(实测,8 系列×8192 行,release)**:增量更新 prepare median 2.41ms→**2.09ms(-13%)**;命令内存遍历从 8 份(7×to_vec+拼接)降为 1 份(惰性一次性,无人读则 0 份);重复读视图 ~0.1µs。
- **诚实修正**:任务背景假设「克隆含扁平数组」在基线不成立(frame 早已是 Arc,克隆恒 O(1));本批真实收益在增量更新路径的内存流量削减,数字如实呈现。
- **等价性证明**:未变系列三 Arc `ptr_eq` 全真;隐藏系列重排下视图 z 序与参考实现逐值一致;预算预检失败时机等价;Send/Sync 经 OnceLock 保证(app 线程持有不破坏)。
- 验证:frame_chunks 相关 4 项新测试;chart 全家族 26 目标+lib 119 通过;check 0 warning。
- 剩余:renderer 侧 GPU staging 直接消费 chunk(消除最后一次拼接)需动 deep2d 消费面,后续批次。

## P1-06 GPU 分配与传输策略(评估+可观测性)

**结论:不引入 ring/arena/池,用数据否决并固化现状。** 依据:

- 分配成本实测 ~0.7–1.0µs/次,占局部更新 stage(~0.5ms)的 0.1–0.2%,噪声级;stage 成本主体是重新细分与传输编码。
- 安全复用需要上一代 buffer 的 Arc,交接点在 `deep2d_gpu.rs`(本切片禁区);经 cache 复用会导致缓存投毒(旧 content key 指向被覆写 buffer)。「发布即不可变、写时新分配」是零围栏成本的刻意设计,数据证实取舍成立。
- 落地:`VertexTransferStats.buffer_allocations` 可观测字段(copy/fallback 各置 1,整 key 命中 0)+三场景(冷启动/局部 1 点/全量替换)字节预算断言、两次逐像素旧帧保护、release 计时基准。持久分配器如需立项,数据可直接作为依据(需跨 deep2d_gpu 模块)。

验证:release/debug GPU 测试多轮全绿(像素一致断言不变);bin 88/lib 119;check 0/0。

## 合并回归(最终态,2026-09-16 03:45)

- Native 全套:**760 通过 / 0 失败 / 55 GPU 忽略**(105 目标),`test-output/p005-native-full.log`;`cargo check --all-targets` 0 warning。
- 真实 GPU 窗口(RTX 4060 Laptop/Vulkan,EXE SHA `790b1df992acecc96166472f1c0cb29310ab25029e4dbe3adc4251e526e94fd0`):静态包交互序列(经 chunk-view 新路径)与 sim 包 8 阶段全流程均通过,scopes/callbacks clean,恢复检查点提交;`test-output/p005-smoke-*.log`。

## P1-05 第二批:GPU staging 直连 chunk —— 测量结论(2026-09-16 接手会话)

**结论:不改造消费面,用数据否决。** 本批先把「最后一次拼接」拆成两个可分别计量的成本
(`tests/chart_frame_chunks.rs`,release,8 系列×8192 行,1280×720):

| 项 | median | 说明 |
| --- | --- | --- |
| 呈现层 `display_list().clone()` | **0.0149 ms** | `compose_tooltip` 每次呈现做的第一件事 |
| 扁平视图首次物化(拼接) | **0.366 ms** | `OnceLock` 首读,每帧至多一次、命中后为 0 |
| 扁平视图重复读 | **0.0001 ms** | 缓存命中 |
| 局部数据更新(重建 1 系列) | 0.757 ms | 排除扁平视图 |

判读:

- **呈现层克隆不是瓶颈**:0.0149ms 占 P1-05 第一批实测 prepare 2.09ms 的约 0.7%,
  且在 8 命令的夹具上克隆本身就是 8 个 String + 8 个 PathCommand,量级与命令数线性。
- **真正的成本是首次物化 0.366ms**,它只在「本帧有人读扁平视图」时发生一次;
  每帧呈现路径必然读它一次,因此这笔成本是每帧固定付出的。
- 要消除它,必须让 `runtime_prepare` 直接按 chunk 消费命令/资源——那会改动
  `Deep2dDisplayList` 的消费面契约(校验、z 序定版、资源 revision 定版都在拼接期完成),
  属跨模块公共合同改动。

**取舍**:0.366ms 相对同夹具的全量重渲染(27.1ms,P1-10 实测)是 1.3%,
相对静态帧(0.21ms)才是同一量级。移除它的收益不足以支撑一次公共合同改动,
且会破坏「拼接期统一定版 z 序/revision」这一已由测试锁定的语义。数据否决,记录在案。

## P1-09 纯二维残余分配 —— 测量与决策(2026-09-16 接手会话)

先测成本,再决定裁什么。纯 2D 场景(有 deep2d、无任何 3D 实例)的常驻分配:

| 资源 | 规格 | 占用 | 是否与像素相关 |
| --- | --- | --- | --- |
| IBL(内建 studio-ibl) | specular 2046 + diffuse 384 + brdf 1024 texels,rgba16float | **约 27 KB** | 仅三维着色使用 |
| CSM shadow map | 紧凑档 64×64×4 cascades×4B | 64 KB | 仅三维阴影使用 |
| 前向目标(HDR+4xMSAA+Depth) | RGBA16F 8B/px + MSAA×4 32B/px + Depth24 4B/px | **约 44 B/px**;1280×720 ≈ **40 MB** | `output_pass` 以 `LoadOp::Clear` 覆盖,Deep2d 直接画 surface |

判读:

- IBL 与紧凑阴影合计约 91 KB,**裁剪收益可忽略**;它们已在 D09/D06 被压到紧凑档。
- **前向目标是唯一大头**:约 44 字节/像素,随分辨率线性增长。已确认 `output_pass.draw`
  使用 `LoadOp::Clear`,而 Deep2d 绘制在其之后、直接写 surface `view`,两者无像素依赖
  (见 `renderer/frame.rs` 的绘制顺序)。因此纯 2D 帧里它确实是被白造的。
- 但跳过它需要重排主渲染路径(`output_pass` 绑定 `hdr_view`),属跨模块改动;
  且必须保持差分探针(shadow/IBL probe)的证据面,探针在场时不得裁。

**本批落地**:新增 `content_profile::planeless` / `skip_forward_targets` 判据(含探针与实例
两道否决),把决策条件写进代码并有测试锁定;实际跳过帧路径的改造留待独立切片
(需要真实窗口像素对比与双主题闭环,不在纯 CPU 批次内冒险)。

**诚实声明**:本批**只交付测量与判据**,未改变任何帧路径行为;前向目标跳过尚未实施。
