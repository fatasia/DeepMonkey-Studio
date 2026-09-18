# AI 3D 生成 API 参考

Tripo3D 与腾讯混元 3D 通过平台服务端创建和查询生成任务。先配置供应商，再提交描述；模型生成完成后检查结果并导入场景。

## 配置与使用

在“系统 → AI 与模型 → 3D 生成模型”配置服务。Tripo3D 使用 API Key；腾讯混元 3D 使用 Secret ID、Secret Key、地域和模型版本。供应商凭据由服务端使用。

进入参数化生成页面，选择供应商，输入至少 3 个字符的模型描述，点击“开始生成”。完成后预览或下载模型，再决定是否导入场景。首次使用先生成一个简单零件，检查尺寸、朝向与材质。

## 提交生成任务

客户端通过当前登录会话调用平台接口：

```http
POST /api/ai/modeling3d/generate
Content-Type: application/json
```

```json
{
  "prompt": "带四个安装孔的机械支架",
  "provider": "tripo3d"
}
```

`prompt` 为必填字符串，去除首尾空格后至少 3 个字符。`provider` 使用 `tripo3d` 或 `tencentHunyuan`；省略时选择 Tripo3D。

提交响应包含 `taskId`、`status` 和 `provider`。供应商提交失败时，响应也可能携带 `status: "failed"` 和 `error`；调用方必须检查任务状态，不能仅按 HTTP 成功码判断生成成功。

## 查询任务状态

```http
GET /api/ai/modeling3d/:taskId
```

将 `:taskId` 替换为提交接口返回的平台任务 ID。响应字段含义：

- `status`：`pending`、`running`、`success` 或 `failed`。
- `progress`：供应商提供的进度；可能省略，不能把缺失值当成 0 或完成。
- `modelUrl`：成功结果的下载地址；下载后仍需检查文件格式和完整性。
- `error`：失败原因；可能省略。
- `provider`：处理任务的供应商。

任务终止后停止轮询。暂时的查询异常可能保留上次状态；长时间停留在 `running` 时，应检查服务端与供应商任务记录，避免直接重复提交产生额外任务。

当前平台任务记录保存在 API 进程内存中，重启后原平台任务 ID 可能返回 404。重启不代表供应商任务已取消，应先核对供应商侧结果。

## 供应商适配方式

当前 Tripo3D 适配器向已配置 Base URL 的 `/v2/openapi/task` 提交 `text_to_model` 请求，并查询同一路径下的任务 ID。成功结果优先读取 `pbr_model`，其次读取 `model`。服务地址与协议版本应和所部署适配器一致。

腾讯混元适配器使用 TC3-HMAC-SHA256 签名，以 `SubmitHunyuanTo3DProJob` 创建任务，以 `QueryHunyuanTo3DProJob` 查询结果。当前实现使用 `ai3d` 服务和 `2025-05-13` API 版本；返回文件优先选择 GLB。Secret Key 用于签名，不能当成 Bearer Token 调用。

接口描述对应当前仓库实现。部署升级时同时核对适配器代码与供应商配置，调用方只使用平台任务 ID。

## 排查错误

- 400：模型描述过短，或供应商凭据不完整；补齐输入与设置。
- 401：登录失效；重新登录后再查询任务。
- 404：平台任务不存在或进程已重启；先核对原供应商任务。
- 503：未配置 3D 生成服务；由管理员完成配置。
- `failed`：检查响应中的 `error`，区分供应商拒绝、额度、参数与网络问题。

模型能下载但无法显示时，按[模型导入与格式选择](/docs/model-import)检查几何、贴图和格式；平台请求的其他排障方法见[API 参考](/docs/api-reference)。
