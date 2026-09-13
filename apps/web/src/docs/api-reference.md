# 图文 API 与平台参考

这页把常用 API、请求边界和排错路径放在一起。先看图，再复制最小示例；密钥只进入服务端配置，不写进浏览器代码、脚本或文档截图。

![从编辑器到 Worker、数据接口和 3D 生成服务的调用关系图](docs-assets/api-call-flow.svg)

## API 分层

- **编辑器脚本 API**：`studio` 和 `ctx` 面向项目内的二维组件、三维对象、相机、动画、数据和业务事件。Worker 脚本没有 DOM、`window`、`document` 或原始渲染器。
- **Studio HTTP API**：浏览器通过当前登录会话访问 `/api/...`。认证、项目权限和审计由 API 服务处理，前端不直接拼接数据库请求。
- **云渲染 Worker API**：独立 Worker 只暴露版本化 `/v1/...` 接口，必须带 `Authorization: Bearer <token>`。根地址没有业务路由，直接访问根地址返回 `404` 是正常现象。
- **3D 生成供应商**：Tripo3D 与腾讯混元 3D 的地址、模型、协议和密钥在“系统 → AI 与模型 → 3D 生成模型配置”保存。没有对应适配器注册时，保存配置不等于已连通或已调用供应商。

## `studio` Worker API

读取对象、驱动动画和写入业务数据时，优先使用稳定句柄：

```ts
export function onData(ctx) {
  const temperature = Number(ctx.getData("motor.temperature") ?? 0);
  const motor = ctx.object("motor-01");
  motor?.setColor(temperature >= 80 ? "#ef4444" : "#22c55e");
  motor?.setOpacity(temperature >= 80 ? 1 : 0.82);
  ctx.emit("motorTemperatureChanged", { temperature });
}
```

相机和动画属于同一场景上下文；需要直接访问 Three.js 原始对象时，只能在可信交互脚本中使用：

```js
studio.camera.setPose([12, 6, 12], [0, 1, 0], {
  near: 0.05,
  far: 100000,
  fov: 55,
});
studio.camera.setMode("orbit");
studio.object("robot-01")?.focus();
studio.animation.play("inspection");
```

脚本声明应遵循最小权限：读取数据用 `data.read`，写入用 `data.write`，联网用 `network.connect`，AI 调用用 `ai.invoke`。API 失败会拒绝 Promise；脚本应保留上一个稳定值，并把失败写入日志，而不是伪造成功。

## 云渲染 Worker API

### 健康检查

`GET /v1/health` 返回 Worker 合同版本、容量、GPU 和编码器证据。请求必须携带令牌：

```bash
curl https://worker.example.com/v1/health \
  -H "Authorization: Bearer $CLOUD_RENDER_WORKER_TOKEN"
```

如果浏览器设置页显示 `HTTP 404`：

1. Worker 地址填写服务根地址，例如 `https://worker.example.com`，不要填 `https://worker.example.com/v1`。
2. 直接打开根地址得到 `Route GET:/ not found` 属于预期；设置页会实际请求 `/v1/health`。
3. `401 Worker token 无效` 说明路由存在但令牌不匹配，应重新核对 `CLOUD_RENDER_WORKER_TOKEN`。
4. 只有 `/v1/health` 带正确令牌返回 `200` 且 `status=ready`，才可创建会话。

### 会话生命周期

- `POST /v1/sessions`：按已发布场景地址、项目/场景 ID、宽高、帧率和编码器偏好创建会话。
- `GET /v1/sessions/:id`：读取 `starting`、`media-ready`、`failed` 或 `stopped` 状态。
- `DELETE /v1/sessions/:id`：停止会话；重复停止返回幂等成功。
- `GET /viewer/:id`：打开 Worker 观看页。观看页通过 `/v1/viewer/:id/offer` 与 `/v1/viewer/:id/answer` 完成 WebRTC 协商。

最小创建请求示例：

```bash
curl https://worker.example.com/v1/sessions \
  -H "Authorization: Bearer $CLOUD_RENDER_WORKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "contractVersion": 1,
    "scope": {
      "projectId": "project-1",
      "sceneId": "scene-1",
      "publishedAt": "2026-09-10T00:00:00.000Z",
      "publicationUrl": "https://studio.example.com/api/public/scenes/scene-1",
      "renderUrl": "https://studio.example.com/published/scene-1"
    },
    "render": {
      "width": 1920,
      "height": 1080,
      "framesPerSecond": 60,
      "codecPreferences": ["h264", "av1"]
    }
  }'
```

### 404 与其他错误的判断

- `404 Route GET:/ not found`：访问了 Worker 根地址，非故障。
- `404 /v1/v1/health`：地址末尾重复填写 `/v1`；当前 SDK 会自动兼容并去掉末尾版本段。
- `401`：令牌缺失或错误。
- `409`：场景未发布、发布时间不一致或旧会话仍占用容量。
- `502`：Studio API 无法从服务端访问 Worker；检查 Worker 监听地址、防火墙、反向代理和 `CLOUD_RENDER_WORKER_PUBLIC_ORIGIN`。

## 3D 生成模型配置

设置页为每个供应商保存独立配置档：

- **Tripo3D**：Provider ID、V3 Base URL、模型名、协议和 API Key。
- **腾讯混元 3D**：Provider ID、腾讯云 API 地址、模型名、协议和 API Key。
- 密钥只在保存请求中提交；再次读取只返回 `apiKeyConfigured`，不会回显明文。
- 配置可先保存，再由对应适配器负责连接测试、异步任务轮询、结果下载和资源入库。没有适配器时，页面明确显示“仅保存配置”，不把配置伪装成生成成功。

供应商调用建议使用异步任务合同：提交任务 → 保存供应商任务 ID → 轮询状态 → 下载 GLB/纹理 → 执行模型完整性检查 → 写入项目资源并保留来源和版本。超时、限流和取消必须回到可重试状态。

## 图像、数据和资源 API 的共通约定

- 图片和文档接口返回来源、尺寸、媒体类型和校验摘要；页面展示真实图片，不用占位色块代替。
- 数据接口先连接测试，再运行数据集，最后发布接口；错误应保留请求 ID、状态码和下一步动作。
- 资源导入保留原文件，派生模型和优化结果写入新版本；失败时可以重试或回退，不覆盖原件。
- 所有跨页面跳转保留项目 ID、场景 ID、资源 ID 和当前返回路径，避免从资源、优化器、参数化建模回到错误项目。

## 参考官方文档

本项目只借鉴公开的交互和 API 组织方式，不复制第三方品牌视觉或代码：

- [ThingJS 摄像机与场景制作文档](https://docs.thingjs.com/)：对象观察、相机飞行和园区级场景组织。
- [帆软 FVS 画布编辑及自适应](https://help.fanruan.com/)：画布、分页和等比自适应的说明方式。
- [Three.js WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)：`HTMLCanvasElement | OffscreenCanvas`、裁剪面和渲染器诊断边界。
- [Tripo Developers API](https://developers.tripo3d.ai/)：V3 生成任务 API；Tripo 官方已公告 V2 将于 **2026 年 10 月 1 日** 退休。
- [腾讯混元 API 概览](https://cloud.tencent.com/document/product/1729/101848)：腾讯云 API 版本、请求和错误码入口。
- [腾讯混元 API Key 管理](https://cloud.tencent.com/document/product/1729/111008)：开通、创建和管理密钥。

参考链接用于解释外部平台的公开概念；实际项目能力、适配器状态和验证结果以本页与系统设置中的状态为准。
