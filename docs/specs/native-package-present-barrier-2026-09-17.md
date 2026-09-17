# RuntimePackage 三维增量呈现后发布

日期：2026-09-17。已接 RenderPacket/Shader-only 增量路径；完整 renderer 替换仍待。

## 实现

`package_live.apply_incremental` 复用 RenderPacket 呈现守卫：预算/身份预检、临时安装候选、真实 surface 绘制、成功后提交 GPU/CPU/发布快照。失败保留旧内容，跳帧和恢复沿用宿主处理与 100 ms 单候选重试。

重试明确保存 `Scene` 或 `Deep2d` 类型，不凭包扩展名或临时状态猜测目标。新 generation 清理旧重试，最终提交仍在 mailbox latest-wins 锁内。呈现成功后调用已有恢复检查点入口；未附带待保存检查点的包不额外创建记录。

测试夹具修改实际 WGSL 基础颜色计算，并复用生产 Shader 的 source/module/pass/package 哈希算法重新封装。RuntimePackage 与 Shader 使用不同 canonical 合同，不能交叉使用哈希。没有改生产 ABI、校验规则或新增依赖。

## 实测

- RTX 4060 Laptop / Vulkan：三维包与 Shader 包各 1 项显式 GPU 测试。零尺寸连续 generation 1/2 均不发布 CPU/快照/缓存；恢复后只发布 generation 2，renderer ID 不变。
- 三维包夹具带 Deep2D overlay；Shader 夹具包含真实材质管线，改变一份模块的颜色计算后，相关模块/管线重新校验、创建并绘制。没有把版本号变更当作 WGSL 变化。
- X 拖放与 X 文件监听 2 项显式 GPU 回归通过，覆盖跳帧重试、坏 JSON、普通包拒绝与检查点保留。
- 普通包及 Shader 包各一次 `--smoke-package-live` 真实文件测试通过：坏 JSON 保留旧 scene，有效文件恢复后 scene 1→2，同 renderer 呈现成功。
- bin 120 passed / 42 ignored；上述 4 项 GPU 测试另行显式通过。clippy `--tests -D warnings`、build、fmt、repository gate 通过。

GPU surface 成功与状态断言不等于像素真值。Shader 改色的独立像素对照、双轮视觉检查、完整 renderer/环境/相机更新及跨端发布矩阵仍待；不把本片标为 P3 整项完成。
