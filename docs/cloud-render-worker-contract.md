# 云渲染 GPU Worker 对接合同

Industrial Studio 同时提供控制面和可部署的 Reference Worker（`apps/cloud-render-worker`）。Reference Worker 使用 Chromium 打开真实发布页并请求 WebGPU，初始化失败时由发布运行时自动回退 WebGL；Worker 捕获最终实际 canvas，由 Chromium WebRTC 栈完成硬件编码，并通过 DataChannel 回传鼠标键盘。控制面不会用延时器、WebSocket 已连接或信令成功冒充媒体可用。

## 服务器配置

```dotenv
CLOUD_RENDER_WORKER_URL=https://gpu-worker.example.com
CLOUD_RENDER_WORKER_TOKEN=replace-with-worker-control-token
CLOUD_RENDER_PUBLIC_ORIGIN=https://studio.example.com
```

`CLOUD_RENDER_PUBLIC_ORIGIN` 必须能被 GPU Worker 访问。控制面会把已发布场景 URL 传给 Worker；草稿场景不能创建云渲染会话。

可选超时配置：

```dotenv
CLOUD_RENDER_REQUEST_TIMEOUT_MS=5000
CLOUD_RENDER_HEALTH_MAX_AGE_MS=15000
CLOUD_RENDER_MEDIA_MAX_AGE_MS=15000
```

## 认证与版本

所有 Worker 请求使用：

```http
Authorization: Bearer <CLOUD_RENDER_WORKER_TOKEN>
Accept: application/json
```

请求与响应的 `contractVersion` 当前必须为 `1`。未知版本会被控制面拒绝。

## 健康与容量

```http
GET /v1/health
```

```json
{
  "contractVersion": 1,
  "workerId": "gpu-worker-01",
  "status": "ready",
  "observedAt": "2026-08-25T12:00:05.000Z",
  "capacity": { "maxSessions": 4, "activeSessions": 1 },
  "gpu": {
    "vendor": "NVIDIA",
    "model": "L40S",
    "memoryMiB": 49152,
    "encoder": {
      "hardware": true,
      "codecs": ["h265"],
      "evidenceSource": "runtime-loopback",
      "evidenceDetail": "h265: MediaFoundationVideoEncodeAccelerator + power-efficient"
    }
  }
}
```

只有状态为 `ready`、健康证据未过期、容量未满且声明硬件编码器时，控制面才会请求新会话。Reference Worker 会为浏览器支持的 H264/AV1/H265 分别建立真实 canvas WebRTC 回环；只有产生 RTP，且 `webrtc-internals` 同时记录非软件 `encoderImplementation` 与 `powerEfficientEncoder=true` 的格式才进入 `codecs`。同一块显卡可能只有 H265 走硬件，而 H264/AV1 仍是 OpenH264/libaom 软件实现，此时控制面只选择 H265。

## 创建会话

```http
POST /v1/sessions
Content-Type: application/json
```

```json
{
  "contractVersion": 1,
  "scope": {
    "projectId": "default",
    "sceneId": "scene-1",
    "publishedAt": "2026-08-25T12:00:00.000Z",
    "publicationUrl": "https://studio.example.com/api/public/scenes/scene-1",
    "renderUrl": "https://studio.example.com/published/scene-1?renderer=webgpu"
  },
  "render": {
    "width": 1920,
    "height": 1080,
    "framesPerSecond": 60,
    "codecPreferences": ["h264", "av1"]
  }
}
```

Worker 启动中可以返回：

```json
{
  "contractVersion": 1,
  "workerSessionId": "worker-session-1",
  "sceneId": "scene-1",
  "publishedAt": "2026-08-25T12:00:00.000Z",
  "state": "starting",
  "viewerUrl": "https://gpu-worker.example.com/watch/worker-session-1"
}
```

此时 Industrial Studio 只显示“等待媒体证据”，不会显示“运行中”。

## 查询媒体就绪

```http
GET /v1/sessions/worker-session-1
```

媒体真正可用时返回：

```json
{
  "contractVersion": 1,
  "workerSessionId": "worker-session-1",
  "sceneId": "scene-1",
  "publishedAt": "2026-08-25T12:00:00.000Z",
  "state": "media-ready",
  "viewerUrl": "https://gpu-worker.example.com/watch/worker-session-1",
  "roundTripLatencyMs": 46,
  "mediaEvidence": {
    "kind": "webrtc-outbound-rtp",
    "observedAt": "2026-08-25T12:00:08.000Z",
    "peerConnectionId": "peer-1",
    "videoTrackId": "video-1",
    "codec": "h265",
    "hardwareEncoder": true,
    "encoderImplementation": "MediaFoundationVideoEncodeAccelerator (NVIDIA HEVC Encoder MFT)",
    "encoderEvidence": "runtime-stats",
    "width": 1920,
    "height": 1080,
    "framesEncoded": 120,
    "packetsSent": 480,
    "bytesSent": 1200000
  }
}
```

`framesEncoded`、`packetsSent` 和 `bytesSent` 都必须大于零，`observedAt` 必须在服务器配置的新鲜度窗口内。只有该证据通过校验，会话才进入 `streaming` 或按延迟进入 `degraded`。

Worker 失败必须返回非空 `failureCode`：

```json
{
  "contractVersion": 1,
  "workerSessionId": "worker-session-1",
  "sceneId": "scene-1",
  "publishedAt": "2026-08-25T12:00:00.000Z",
  "state": "failed",
  "failureCode": "encoder_initialization_failed"
}
```

## 停止会话

```http
DELETE /v1/sessions/worker-session-1
```

Worker 返回 `204`，或明确返回 `404` 表示该会话已不存在，控制面才进入 `closed`。超时或其他错误会显示“失败，未确认关闭”，并保留 Worker 会话 ID 供管理员重试。

场景重新发布、撤回发布或删除前，API 会先请求停止旧 Worker 会话。无法确认媒体停止时，发布变更会失败，避免产生不可管理的孤儿 GPU 会话。

## Reference Worker 原生启动

项目统一采用原生进程与系统服务，不使用容器。Windows 本机调试：

```powershell
.\tools\cloud-render-worker\start.ps1 -Token 'replace-me' -PublicOrigin 'http://localhost:4200'
```

API 侧配置：

```dotenv
CLOUD_RENDER_WORKER_URL=http://127.0.0.1:4200
CLOUD_RENDER_WORKER_TOKEN=replace-me
# 必须同时能返回发布 JSON，并能打开 /published/:sceneId 页面。
CLOUD_RENDER_PUBLIC_ORIGIN=http://127.0.0.1:5173
```

Worker 创建会话时先读取 `publicationUrl`，严格比较项目、场景和发布时间，再打开 `renderUrl`。观看端打开并提交 WebRTC answer 后，Worker 才可能从发送端 `RTCPeerConnection.getStats()` 获得 `framesEncoded`、`packetsSent`、`bytesSent`。未打开观看端时，会话保持 `starting`。

若目标 Chromium 确实使用硬件编码、但不暴露可机读证明，可由运维完成 `chrome://webrtc-internals` 和 GPU 利用率核验后显式配置：

```dotenv
CLOUD_RENDER_VERIFIED_HARDWARE_CODECS=h264
```

此时健康与媒体证据都会标记为 `operator-attested`，系统管理页明确显示“运维确认”，不会伪装成运行时回环证明。

## 唯一外部前置与生产边界

- 必须有宿主机 GPU、正确驱动，以及可被服务账户启动的 Chromium/Chrome。CDP `SystemInfo` 只用于识别 GPU、驱动和 `video_encode` 前置状态；即使 `videoEncoding=[]`，只要真实 WebRTC 回环产生 RTP，且 `webrtc-internals` 证明非软件实现并报告 `powerEfficientEncoder=true`，Worker 仍可为 `ready`。若浏览器不暴露该证明，只接受显式运维 attestation；不会把 SwiftShader、OpenH264、libvpx 或 libaom 软件编码伪装成硬件编码。
- 跨公网或复杂 NAT 部署必须提供可访问的 STUN/TURN 服务及凭据；同网段直连可以不配置 TURN。
- HTTPS 页面应使用 HTTPS Worker，避免浏览器混合内容限制。

Reference Worker 已包含单 Worker 容量、发布快照校验、Chromium 渲染、WebRTC offer/answer、鉴权观看页、输入 DataChannel、真实媒体证据及停止回收。生产集群仍需在其前方增加多 Worker 调度、租户配额、证书/密钥托管和 GPU 监控告警，这些不会影响当前合同。

## 2026-08-25 本机真实端到端验收

在 Windows、NVIDIA GeForce RTX 4060 Laptop GPU 和本机 Chromium 上完成以下真实链路：

1. 创建并发布临时场景；
2. API 一键启用并创建 Worker 会话；
3. Worker 校验发布 JSON，并加载 `/published/:sceneId` 实际页面；
4. 观看端完成 WebRTC offer/answer，输入 DataChannel 状态显示“媒体与输入已连接”；
5. 会话返回 `media-ready`，实际证据为 H265、1280×720、41 `framesEncoded`、73 `packetsSent`、37,398 `bytesSent`；
6. `encoderImplementation` 为 `MediaFoundationVideoEncodeAccelerator (NVIDIA HEVC Encoder MFT)`，`powerEfficientEncoder=true`，`encoderEvidence=runtime-stats`；
7. `DELETE` Worker 会话返回 204，浏览器上下文和媒体会话被回收。

同一环境的 H264 为 OpenH264、AV1 为 libaom，均被正确判定为软件编码并排除；健康端点只声明 `["h265"]`，实际场景会话也强制协商 H265。这个结果说明编码格式必须以每台 Worker 的真实回环探针为准，不能根据显卡型号推断，也不能固定 H264。

本次没有验证公网 NAT/TURN、Linux 容器中的具体 GPU 驱动组合、多 Worker 调度或长时间压力稳定性；这些属于部署环境验收，不影响单 Worker 控制面与媒体闭环已经真实可运行的结论。
