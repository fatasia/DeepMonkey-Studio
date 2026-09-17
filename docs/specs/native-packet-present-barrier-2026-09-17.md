# Native RenderPacket 呈现后发布

日期：2026-09-17。`--packet-live` 已接入；RuntimePackage 的三维增量、完整 renderer 替换继续待办。

## 协议

候选先暂存并通过缓存预算/修订预检，再临时安装 scene、culling、LOD、shadow 绑定进行真实 surface 绘制。守卫恢复原场景；仅 `Presented` 后连续提交缓存、CPU 内容和 watcher 的 published key。预检至提交不让出事件循环，也不改变缓存所有权。

`Skipped` 保留旧内容；`Recover` 调用既有宿主恢复，从旧 CPU 内容重建 renderer，再重试最新候选。每个 transport 只保留一份待重试内容，100 ms 退避；更新的 generation 替换旧重试。最终发布继续在 mailbox 的 latest-wins 锁内，后台线程不能插入半次发布。预检或 GPU 失败保持旧发布状态，等待下一次有效改写。

不增加第三方依赖，不改变材质、灯光、色调映射或界面令牌。恢复到旧阴影状态时失效 shadow cache，避免候选绘制留下错误阴影复用。

## 验证

- RTX 4060 Laptop / Vulkan 显式 GPU 测试 `skipped_packet_updates_retain_state_and_only_retry_latest`：零尺寸连续提交 generation 1/2，CPU key、published key、缓存、bounds 和 shadow version 保持旧值；提前 retry 不提交。
- 同测试注入宿主 `Recover`，实际创建新设备/renderer，从旧内容恢复；尺寸恢复后仅 generation 2 呈现并发布，generation 1 被淘汰。该项是恢复结果注入，不是驱动随机故障实验。
- 同修订改变几何的 generation 3 在呈现前拒绝；发布版本、CPU key、GPU scene evidence 保持 generation 2。
- 真实 `--smoke-packet-live` 文件改写链路通过；同 renderer 更新 scene 1→2，仅上传 144 bytes instance、复用复制 432 bytes，几何/材质无新上传。
- bin 回归 119 passed / 40 ignored，新 GPU 项另行显式通过；clippy `--tests -D warnings`、build、fmt 和 repository gate 通过。

## 待办

RuntimePackage 三维增量/Shader 和完整 renderer 更新尚未接本屏障；长期恢复矩阵、跨端同步合同与完整视觉验收仍待。设计对标沿用 Unity 渲染一致性与西门子状态严谨性；本片未新增浏览器/OS 双轮截图，视觉十维未评分，不把真实 surface 成功呈现当成完整视觉验收。
