# 实例与聚光阴影重复上传优化

本切片对应 OPT-01/OPT-03，复用现有实例事务与阴影生命周期，不新增缓存或调度器。

## 已完成

- `packetInstanceUpdate.ts` 分开比较当前实例数据与历史变换，只上传变化的缓冲。材质绑定变化仍更新批次，新增/扩容仍初始化两份数据。回滚按实际尝试写入的缓冲逆序恢复，包含抛错前已部分写入的缓冲。
- `localSpotShadowRuntime.ts` 保留移动遮挡物所需的强制重绘，但仅灯光签名变化时重新打包和上传矩阵/元数据。失败会使签名失效，下一帧重新上传。

## 验证与收益边界

4 文件 / 60 项聚焦测试及 deep-engine 类型检查通过。覆盖材质更新、变换历史提交、分配增长、批次移除/恢复、后批次失败与回滚失败、灯光变化/重排/禁用、连续强制重绘和失败恢复。

| 固定用例 | 原写入 | 本次写入 |
|---|---:|---:|
| 16,384 实例仅材质数值变化 | 当前 2,359,296 B + 历史 786,432 B | 仅当前 2,359,296 B；上传字节减少 25% |
| 同一实例 120 次提交前变换更新，含初始化 | 244 次 buffer 写入 | 124 次；历史仍在成功提交后推进 |
| 固定四盏聚光灯，强制重绘一次 | 5 次 / 1,920 B uniform 重写 | 0 次重复 uniform 写入，draw 保留 |

实例压力用例将增量后的当前与历史数据和全包重建结果逐项比较，完全一致；无变化再次更新不写入。现有单包上限是 16,384 实例，20,000 实例压力档尚未覆盖，未为测试提高资源预算。

上述数字是实际调用路径的队列替身记录与字节断言，不是整帧 GPU 时间或 FPS 提升。未新增真实 GPU 读回或同场景 P95/P99 测量；OPT-01/03 的完整性能验收仍待。全量测试与完整产品集成按用户顺序后置。

## 复现

在 `packages/deep-engine` 执行：

```sh
pnpm exec vitest run src/webgpu/packetBuffers.test.ts src/webgpu/packetBuffersValidation.test.ts src/webgpu/packetBuffersResidency.test.ts src/webgpu/localSpotShadowRuntime.test.ts --exclude '**/test-output/**'
pnpm exec tsc --noEmit -p tsconfig.json
```
