# DE26/C03 作者发布到生产 PBR 像素

日期：2026-09-17。范围：Three 作者对象→RenderPacket→Runtime Package→浏览器生产 `PbrRenderer`，并覆盖 premultiplied bit128、镜像实例和双面透明。

## 生产缺陷与修复

- `buildDeepRuntimePackage` 原先在验证前拒绝 Three 桥有意保留的 `Float64Array` world matrix，导致桥输出无法直接发布。现仅在不可变 JSON 快照边界把实例 `Float64Array` 转为数组，不修改作者 packet；后续仍由既有 runtime validator 检查 Float32 可表示性。
- 生产 PBR WGSL 用 `select` 选择两个 `DeepWeightedOitOutput` 结构体，Chrome/Dawn 真实编译拒绝。现改为 bit128 分支返回，plain/material 两个透明入口保持一致。

## 纵向证据

- 作者源：真实 `THREE.MeshStandardMaterial`，含 straight/premultiplied、FrontSide/DoubleSide 和负 X 缩放。
- 发布：`ThreeProjectionBridge.project`→`buildDeepRuntimePackage`→`serializeDeepRuntimePackage`→`parseDeepRuntimePackage`→`materializeRuntimeRenderPacket`；预乘双面镜像最终 flags=`149` (`1 + 4 + 16 + 128`)。
- 绘制：Chrome 153 / NVIDIA Lovelace 真 WebGPU，复用生产 `PbrRenderer`、packet buffers、PBR shader 与 `PbrTransparencyPass`。五个 case 每帧 3 draw calls/14 triangles，`weightedOit=true`，各 3,213 个非背景像素，GPU/session/console/page errors 均为 0。
- 镜像对拍：FrontSide 和 DoubleSide 的普通/镜像全帧 RGBA 最大差均为 1/255，属于 raster 量化级；双面镜像折叠后 batch `mirrored=false`，但 bit1 保留。
- 两轮视觉闭环：1280 深色与 980 浅色，实际 GPU 读回像素回显到证据页；无水平溢出或裁切。证据 JSON SHA-256 `f8879334aad76eaf8c789b8de8c008d0de40eefd1151961f8c9b74dd6417c9bf`；截图 SHA-256 分别为 `e590566e4886f74eb4bdc28b94ffc639628d1b3c5f6afc2397488cc5d069b9fa` 和 `11211ae2026c531fa15af4ff79de2e20460602a1203dc34b80e30faf0a76169a`。

## Kimi-95 自评

| 维度 | 分数 | 依据 |
| --- | ---: | --- |
| 布局构图 | 9 | 五 case 对齐，980 自动换行 |
| 令牌一致性 | 10 | 证据页只用 `base.css` 令牌 |
| 排版 | 9 | 标题、case 和机读报告分层清楚 |
| 交互状态完备 | 9 | 无交互控件；运行/成功/失败文本明确 |
| 动效质量 | 9 | 固定像素证据，不引入无动机动画 |
| 3D 渲染质量 | 9 | 生产 PBR/OIT/环境光实际画面 |
| 信息设计 | 9 | 画面与 hash/flags/诊断一一对应 |
| 反馈即时性 | 9 | 页面实时显示编译/读回状态 |
| 响应式与主题 | 9 | 1280 dark / 980 light 实测 |
| 语义与文案 | 9 | case 名、flags 和错误原文可追溯 |

## 边界

`side=back` 和 `BLEND + depthWrite=true` 仍在冻结支持矩阵外，不属于 C03 已承诺语义。本切片没有新增 UI 或颜色令牌；证据页是真像素诊断，不是产品展示页。
