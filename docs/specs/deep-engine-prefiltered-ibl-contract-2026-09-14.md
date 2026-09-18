# Shared prefiltered IBL v1

Browser PbrRenderer 与 Native Viewer 共用离线预过滤环境光数据。它不是 HDR 文件解码器，也不包含背景全景图。

## 已完成：合同与消费者

- Runtime Package 的 environment entrypoint 可引用 `deep-engine.ibl-prefiltered` v1；旧 `deep-engine.ibl-reference` / builtin-default 序列化不变。
- 格式固定 `rgba16float`、`base64-le`，六面顺序 `px-nx-py-ny-pz-nz`。specular 保存从顶层到 1×1 的完整 mip 链，diffuse 只保存一层，BRDF LUT 为正方形。
- 每边为 1–2048 的二次幂，全部解码数据合计不超过 64 MiB；预算先于字节扫描/解码。拒绝未知字段、非规范 Base64、截断、NaN、Infinity 和负值；允许 -0。
- `id` 与 `revision` 必须和资源索引一致。`source.contentHash` 是来源声明，不替代实际 payload 的内容哈希；同 id/revision、不同 payload 不得误复用旧环境。
- Browser 使用 `PbrEnvironmentSource.kind = "prefiltered-ibl"`；Native 使用同一包入口。两端都在现有设备准备候选资源，不为环境切换创建第二台设备。

字段定义与验证分别见 `packages/deep-engine/src/runtimePackage/environmentTypes.ts` 和 `environment.ts`。Browser 的 `PbrRenderer.stageEnvironment()` 准备完成不等于发布；后续帧边界才激活，发布前取消仍有效。Native 在同设备离屏验证后呈现，实际成功呈现后才写 last-known-good。

## 已完成：固定夹具验证

共享夹具为 `packages/deep-engine-native/tests/fixtures/runtime-package-prefiltered-ibl-v1.json`，由 `packages/deep-engine/scripts/runtimePackageIblFixture.mjs` 生成。packageHash 为 `7ed183efa7775ccec89b1c4265cfd5f893644472e4e9bac2d287e32ed172739b`。它是仓内生成的合成颜色夹具；全零 source hash 为测试占位，不是外部 HDR 来源核验记录。

2026-09-14 Browser 真 GPU：NVIDIA Lovelace、非 fallback，使用正式 PbrRenderer，方向光强度为零。

| 检查 | 结果 |
|---|---|
| 同 id/revision、不同环境 texel | 3100 像素变化，HDR 亮度和 2486.016845703125 → 3132.354736328125 |
| 候选发布前取消 | 与旧画面最大误差 0 |
| 坏 Base64 | 拒绝，旧画面最大误差 0 |
| 切回原环境、连续候选以最后一次为准 | 与原画面最大误差均为 0 |
| GPU 提交同步抛错 | 丢弃候选、恢复旧环境绑定；下一帧与旧画面最大误差 0 |
| 资源与诊断 | 七帧受管资源均 40，dispose 后 0；GPU scopes 与诊断均空 |

复跑入口：既有 Lab 服务下 `/lab/prefilteredIblProbe.html`。它检查正式渲染器的 HDR 附件，不以展示页观感代替像素断言。协议、上传失败和清理单元测试通过；core/lab 类型检查通过。

Native 另验证标准 PBR 和显式 ShaderMaterial 绑定，分别有 521 / 184 像素变化，失败回滚误差均 0；详细执行证据和构建身份见 [Native P1 独占检查点](deep-engine-p1-live-checkpoint-2026-09-14.md)。本增量已纳入独立 `windows-portable-prefiltered-ibl-drop` 候选；此前两个 Windows ZIP 不变。

## 本轮待办

真实 HDR 离线生产工具、来源核验与资产导入入口；完整 Studio 项目/质量档验收；实时 Native RenderPacket 环境更新；提交后异步 GPU 错误的恢复矩阵。固定合成夹具通过不代表三项目、所有材质或双端完整画质对齐通过。
