# Deep2D 视频资源与播放控制合同 v1

2026-09-21。本链路把 Dashboard 作者态视频的资源引用、播放意图、真实媒体字节和 Windows Native 受限播放带入正式 Deep Runtime Package。

第二切片已接通一个明确的离线资源子集：项目内上传并绑定的 `video/mp4` 经过发布冻结、SHA-256、预算与 ISO BMFF `ftyp` 品牌探测后，以内容寻址媒体资源进入同一运行包。资源入包不改变播放门禁。

第三切片在 Windows Native 增加首帧准备原语：复用固定版本的 `windows` crate，通过内存 `IMFByteStream` 与 `IMFSourceReader` 请求硬件 transform，把真实 H.264 MP4 解为带 100 ns PTS 的 BGRA 顶向紧密帧，再写入 wgpu `Bgra8UnormSrgb` 纹理。该原语尚未接入 Dashboard 连续呈现和媒体时钟，因此播放门禁不变。

第四切片把该原语接入 `DashboardRuntime::prepare_video_playback()`：持有 Source Reader、连续解码真实帧、用外部单调时钟选择 PTS、按 texture serial 更新 GPU，并支持作者 `autoplay`、`muted`、`loop`、`cover/contain/fill` 与窗口生命周期暂停恢复。交互 controls、seek 和音频仍未实现。

第五切片把动态纹理接入正式 EXE Renderer。Dashboard composite 为可见视频节点保留空绘制层，Renderer 按相同 `layer_index`、节点矩形和 clip 把视频 quad 插入 Deep2D ordered pass；换包或设备恢复重建完整 compositor，窗口缩为零和恢复分别冻结、平移媒体时钟。正式窗口产物仍留最终验收。

第六切片增加控制核心：作者 `autoplay:false` 以暂停态启动，Runtime/Renderer bridge 可执行 play、pause、toggle、绝对/相对 bounded seek；Media Foundation 从容器读取 100 ns duration，并以 Source Reader 定位真实帧。键盘与拖动只产出确定性命令，尚未接正式窗口事件和可见控制条，因此 controls/seek capability blocker 暂不解除。

第七切片完成窗口生产接线：GPU compositor 在视频层上绘制播放/暂停按钮、轨道、进度和拖动 thumb；正式 winit 路由将点击、拖动、Space/Enter、左右键、Home/End 送入同一控制 bridge。焦点只落到当前页面的可见视频，视频输入先于三维相机消费。已打包且静音的视频状态升级为 `ready`，controls/seek blocker 删除；音频仍单项失败关闭。

## 已接通

- Web 编译器为每个 `video` 节点写入 `videos[]`：作者节点、运行节点、URI、fit、autoplay、muted、loop。
- 资源允许 `missing`、`external-unresolved` 或经过内容验证的 `packaged`；未打包引用不能伪造资源 ID。
- 未打包资源保持 `blocked/unavailable` 并登记 decoder、frame texture update、media clock、controls、seek；已打包且静音的资源为 `ready/autoplay|poster`，能力缺口为空。
- 作者要求非静音时保持 `blocked/unavailable`，明确登记 `audio-output`；Native 不静默降级作者音频意图。
- Deep Engine 与 Native 分别验证同一约束；Native 可从 `DashboardRuntime::video_diagnostics()` 读取诊断。
- 任何把未打包诊断改成 `ready`、把外部引用标成已打包、漏报能力或引用不存在运行节点的包都会被拒绝。
- 生产发布闭包支持冻结项目内 `video/mp4`；远程 URL 继续保留为 `external-unresolved`，不会冒充离线资源。
- 首批容器 profile 只接受 leading `ftyp` 且声明 `isom`、`iso2`、`mp41` 或 `mp42` 品牌的 ISO BMFF 字节。
- 包内媒体按 `media.<sha256>` 去重，资源 revision 固定为 1，Dashboard 聚合预算 32 MiB。TS 与 Native 都会解码 canonical base64 并复核长度、SHA-256、格式及视频节点所有权。
- Windows 解码边界再次复核字节长度、32 MiB 上限、SHA-256 与内容 ID，随后用 Media Foundation Source Reader 请求硬件 transform 和 RGB32 video processor 输出。
- 解码帧合同固定为顶向紧密 BGRA、`rowBytes = width * 4`、非负 100 ns PTS；源 primaries、transfer、matrix、nominal range 没有容器值时保持空值，不猜测源色域。
- GPU 更新原语只接受固定宽高的合同帧，写入可采样、可回读的 `Bgra8UnormSrgb` 纹理并记录更新时间戳和递增序号。
- 连续播放每次 advance 使用宿主单调时间选择不晚于目标 PTS 的最新帧；倒退时钟、单次超过 2,048 帧预算、维度漂移和计数溢出均失败关闭。
- `loop` 在 EOF 后重建内存 Source Reader，并把下一轮 PTS 映射到递增的展示时间；GPU serial 只在实际纹理更新时增长。
- Media Foundation 显式取消全部 stream 后只选择视频 stream。当前唯一允许的播放模式是作者 `muted:true`；没有音频解码或输出。
- `cover/contain/fill` 生成与 Web 同义的居中裁剪 UV 或目标矩形；窗口生命周期 suspend/resume 冻结并平移时钟，不冒充作者 controls。
- Source Reader/ByteStream 在 Media Foundation 与 COM lease 之前释放；全局 MF lease 支持并发视频，最后一个实例释放时才关闭 MF。
- Renderer 初始化从正式 `PlayerContent.dashboard` 创建 compositor；每帧只在纹理 serial 变化时上传新帧，相同 slot/物理尺寸不重建顶点或重写 uniform。
- 视频 quad 与 Dashboard 图形共享一个 Deep2D ordered render pass；空视频层保留文档 z-order，节点 frame、父级 clip 和 letterbox scissor 继续使用现有 Dashboard/Deep2D 坐标合同。
- 最小化导致零尺寸时暂停播放，恢复有效尺寸时续播；资源替换和设备恢复沿既有 Renderer 原子重建路径释放并重建 MF reader、纹理、bind group 与 fitted quad。
- play/pause 分别冻结和重锚宿主单调时钟；暂停期间位置与 texture serial 不变，继续播放后 PTS 单调推进。seek 被夹在 `[0, duration-frameInterval]`，反向 seek 通过 presentation offset 保持 GPU 展示时间不倒退。
- 独立控制模块把 Space/Enter 映射为 toggle，左右键映射为 5 秒相对 seek（Shift 为 10 秒），Home/End 映射为首尾，拖动比例先夹到 `[0,1]` 再换算媒体时间。
- compositor 的控制条与视频 quad 使用同一 letterbox/scissor 坐标；进度只在播放状态或媒体位置变化时更新顶点缓冲，暂停的静态帧不持续重写控制几何。
- 窗口命中按当前页面、可见性和 z-order 选择视频；控制条按钮切换播放，轨道点击与拖动 seek，正文点击取得视频焦点。焦点失效或窗口失焦会清理拖动状态。

## 验证

- Web：`compileDashboardRasterContent.test.ts`，18/18。
- API：发布冻结与项目资源闭包，45/45。
- Dashboard compiler：6 项通过、2 项需真实 Native/font 环境而跳过。
- Deep Engine：`dashboardVideoValidation.test.ts` + `dashboardComposition.test.ts`，42/42。
- Native：dashboard validation，4/4；内容寻址 MP4 的真实 v5 JSON 重哈希、解析与损坏字节拒绝，1/1。
- Windows Media Foundation：仓内真实 `line-loop.mp4`（39,837 字节，H.264/yuv420p，960×540@30fps）首帧与连续帧解码、PTS 递增、13 秒跨 EOF 循环、DX12/wgpu 上传回读、autoplay=false、用户暂停/继续、1 秒定位、越界夹取、静音门禁、三种 fit 与生命周期暂停恢复，3/3；并发默认测试线程同样通过。
- 正式 Renderer 合成聚焦测试：真实 MP4 连续帧经 DX12 纹理进入 Deep2D ordered pass，目标纹理回读存在非黑解码像素；同时验证 serial 不变不重复计数、play/pause/seek、slot 不变不重建、生命周期暂停恢复、slot 替换释放和 compositor 重建，1/1。
- 正式窗口输入纯命中回归 2/2，覆盖正文、按钮、轨道、边界、隐藏节点和无视频声明；Native bin check 通过。
- TS 能力合同 6/6、Web 视频编译与文档聚焦 31/31，静音包 `ready` 与非静音 `audio-output` blocker 在 TS/Rust 两侧一致。
- API/Web/Deep Engine 类型检查通过；Native `cargo check --lib` 与 `cargo check --bin deep-engine-native` 通过。

## 未完成边界

- 包校验仍只探测 MP4/ISO BMFF 容器身份；codec 支持由 Windows Media Foundation 在准备阶段失败关闭，尚未冻结轨道、codec profile、旋转矩阵或音轨合同。
- 没有音频解码、音画同步、音量或非静音输出。
- 没有正式 EXE 窗口长稳、断流/损坏文件恢复、动态分辨率和 Web 像素对拍证据。
- 没有视频控制的系统级无障碍节点、触控手势或音量控件；本切片只解除键鼠 controls/seek。

因此当前可表述为“Windows Native 正式 Renderer 已具备静音 MP4 连续播放、可见控制条和键鼠 seek，发布合同已解除 controls/seek blocker”；不能表述为音频播放、触控/无障碍完整、正式窗口产物已终验或所有设备必定命中硬件解码。
