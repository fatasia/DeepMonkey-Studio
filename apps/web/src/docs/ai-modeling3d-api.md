# AI 3D 生成 API 参考

本页覆盖 Tripo3D 与腾讯混元 3D 的完整接入流程：平台内部 API、供应商协议、异步任务轮询、GLB 下载和错误处理。配置入口在"系统 → AI 与模型 → 3D 生成模型"。

![3D 生成调用链：参数化页面 → Studio API → 供应商 → GLB 返回](/docs-assets/api-call-flow.svg)

## 使用入口

配置好 API Key 后，进入**参数化生成**页面，左侧栏底部可见 **"AI 3D 生成"** 面板：

1. 下拉框选择 Tripo3D 或腾讯混元 3D
2. 输入模型描述（至少 3 个字符）
3. 点击"开始生成"
4. 等待进度条完成
5. 完成后可预览 / 下载 GLB / 导入场景

## 平台内部 API

平台通过以下接口代理所有供应商调用，前端不直接请求厂商地址。

### 提交生成任务

```
POST /api/ai/modeling3d/generate
Content-Type: application/json
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | string | 是 | 模型描述，至少 3 个字符 |
| `provider` | string | 否 | `"tripo3d"`（默认）或 `"tencentHunyuan"` |

成功响应：

```json
{
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "running",
  "provider": "tripo3d"
}
```

失败响应（HTTP 400）：

```json
{
  "message": "请在设置页配置 Tripo3D 的 API Key"
}
```

### 轮询任务状态

```
GET /api/ai/modeling3d/:taskId
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | string | `"pending"` / `"running"` / `"success"` / `"failed"` |
| `progress` | number\|null | 0–100，仅 running 时有值 |
| `modelUrl` | string\|null | GLB 下载地址，仅 success 时有值 |
| `error` | string\|null | 失败原因 |
| `provider` | string | 使用的供应商 ID |

### 错误码汇总

| HTTP 状态码 | 含义 | 处理方式 |
|------------|------|---------|
| 400 | prompt 过短 / API Key 未配置 | 在设置页配置密钥或补全输入 |
| 401 | 未登录 | 先登录 Deep Monkey Studio |
| 404 | 任务不存在或已过期 | 重新提交 |
| 503 | 3D 生成尚未配置 | 检查设置页 3D 生成卡片 |

## Tripo3D 供应商协议

平台将请求转发为 Tripo3D V2/V3 OpenAPI 调用。

### 创建任务

```
POST https://api.tripo3d.ai/v2/openapi/task
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

```json
{
  "type": "text_to_model",
  "prompt": "a robotic arm base with bolt holes"
}
```

响应：

```json
{
  "data": {
    "task_id": "abc123"
  }
}
```

### 查询任务

```
GET https://api.tripo3d.ai/v2/openapi/task/{task_id}
Authorization: Bearer <API_KEY>
```

响应字段：

| 字段 | 说明 |
|------|------|
| `data.status` | `queued` / `running` / `success` / `failed` |
| `data.progress` | 0–100 百分比 |
| `data.output.pbr_model` | PBR GLB 下载 URL（优先） |
| `data.output.model` | 普通模型下载 URL（备用） |

> **注意**：Tripo 官方已公告 V2 将于 2026 年 10 月 1 日退休。平台默认使用 `https://openapi.tripo3d.ai`，历史 V2 地址请按厂商迁移通知更新。

## 腾讯混元 3D 供应商协议

腾讯混元 3D 使用 TC3-HMAC-SHA256 签名，平台以简化协议透传。

### 创建任务

```
POST https://hunyuan.tencentcloudapi.com/v1/3d/generate
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

```json
{
  "prompt": "a mechanical bracket"
}
```

### 查询任务

```
GET https://hunyuan.tencentcloudapi.com/v1/3d/task/{task_id}
Authorization: Bearer <API_KEY>
```

响应字段：

| 字段 | 说明 |
|------|------|
| `status` | `running` / `success` / `failed` |
| `progress` | 0–100 |
| `model_url` | GLB 下载地址 |

## 配置指南

### Tripo3D

1. 访问 [Tripo Developer Portal](https://developers.tripo3d.ai/) 注册并获取 API Key
2. 进入设置页 → AI 与模型 → 3D 生成模型
3. 选择 Tripo3D 标签，粘贴 API Key
4. Base URL 保持默认 `https://openapi.tripo3d.ai`
5. 点击保存

### 腾讯混元 3D

1. 登录 [腾讯云控制台](https://console.cloud.tencent.com/hunyuan)
2. 开通混元 3D 服务并创建 API Key（[密钥管理](https://cloud.tencent.com/document/product/1729/111008)）
3. 进入设置页 → AI 与模型 → 3D 生成模型
4. 选择腾讯混元 3D 标签，粘贴 API Key
5. Base URL 保持默认 `https://hunyuan.tencentcloudapi.com`
6. 点击保存

## 异步任务流程图

```
┌──────────┐     ┌───────────┐     ┌──────────┐     ┌─────────┐
│ 前端提交  │────▶│ Studio API │────▶│ 供应商    │────▶│ 返回     │
│ prompt   │     │ 鉴权+转发  │     │ Tripo/腾讯│     │ taskId  │
└──────────┘     └───────────┘     └──────────┘     └────┬────┘
                                                          │
              ┌────────────────────────────────────────────┘
              ▼
┌──────────┐     ┌───────────┐     ┌──────────┐
│ 前端轮询  │────▶│ Studio API │────▶│ 供应商    │
│ 3s 间隔  │◀────│ 代理查询   │◀────│ 状态+URL │
└────┬─────┘     └───────────┘     └──────────┘
     │ status === "success"
     ▼
┌──────────────────────────────────┐
│ 前端展示 modelUrl → 预览 / 下载 GLB │
└──────────────────────────────────┘
```

## 官方参考

- [Tripo3D API 文档](https://developers.tripo3d.ai/)：任务创建、查询和模型格式说明
- [腾讯混元 API 概览](https://cloud.tencent.com/document/product/1729/101848)：Action 列表和签名方式
- [腾讯混元密钥管理](https://cloud.tencent.com/document/product/1729/111008)：开通和 Key 生命周期

密钥只保存在服务端元数据存储中，不会出现在浏览器代码、日志或审计记录中。