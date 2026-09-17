# DE26/B05：帧内纹理预算

给现有唯一 transient pool 加驻留上限，不建立第二套 GPU 所有权或流式上传调度器。

## 合同

- `PbrRendererOptions.transientTextureBudgetBytes` 默认 512 MiB，可由调用方收紧；正安全整数，不能关闭为无限值。
- 预算包含空闲、在途和 pending-return 的格式估算字节。只有此前已提交的空闲目标可按最近使用帧淘汰；本帧 release 不能使纹理提前可驱逐。
- 忙碌目标加新请求仍超过预算时，在 GPU 分配前明确拒绝，提示降低分辨率或后处理质量。不静默降画质，不破坏已编码帧。
- `residentBytes/budgetBytes/budgetRejectedCount/budgetEvictedBytes` 并入原统计快照。稳定命中路径不再扫描全部驻留纹理求峰值；仅压力路径排序候选。
- 失败分配/视图不计成功分配；失败帧、resize、device loss、dispose 沿用原所有权回收。

## 验证

14 项聚焦测试通过，覆盖 LRU 空闲淘汰、pending-submit 保护、不可满足请求不破坏缓存、失败后恢复、溢出与非法预算、失败分配与视图回收。
WebGPU 144 文件共 1130 passed / 22 skipped；引擎 typecheck、lab build、runtime purity、repository gate 通过。
source-size 全局仍有其他车道/历史超限，本池合同按职责提取，运行类小于 300 行。

真实 NVIDIA Lovelace 非 fallback adapter 的实验室探针：64 B 上限下四帧清屏读回全部为 `[51,102,153,255]`，
四次过额请求均拒绝，淘汰三个空闲目标共 96 B，驻留峰值 64 B，resize 后为 0，dispose 资源增量为 0，validation error 为 null。
生产首帧 1180×825 / 49 球，池驻留 49,654,832 B，24 个目标，无预算拒绝。
800 px 容器后真实销毁设备，旧 renderer 停止；新设备首帧 947×407，24 次全新分配、驻留 19,667,728 B。
复现入口：`pnpm --filter @bim-studio/deep-engine lab:build`、`lab:serve`，打开 5291 实验室，保存验证记录，读取 `transient-budget` 条目。
最终构建复跑的 [GPU 证据](de26-b05-transient-budget-evidence-2026-09-17.json) 绑定构建与原始报告 SHA-256。
设备恢复本地报告 `webgpu-1789633877946.json` 的 SHA-256 为 `d0254a1d9f1deb876798db3c7c948fd8832c8d22960aff9c29bdf54db98d2a83`。

## 边界

本切片是 B05 的 transient 域，不是整卡完成。阴影/history、geometry/texture/staging 与候选旧资源的跨域总预算报告、上传节流、自动质量降级继续待办。
512 MiB 是明确配置上限，不是硬件 VRAM 查询；格式字节不含驱动内部 tiling/对齐。
两次截图均返回 unavailable，未通过本次视觉闭环，不追加视觉评分。实验室其他探针的 `local-spot-shadow-readback` 失败不计本切片通过。
