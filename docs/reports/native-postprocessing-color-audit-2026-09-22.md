# Deep Native 后处理色彩消费审计（2026-09-22）

## 结论

Deep Native 当前没有消费作者 `ScenePostProcessingState.colorGrading` 的显示域参数。运行包的真实 Native 后处理链仅消费 Bloom、雾和 ACES output transform；WebGL 与 Studio Deep WebGPU 才消费作者的色相、饱和度、亮度、对比度、色温和色调。

因此本次没有实现一条新的 Native 调色链，而是把发布预检的诊断补完整：任意一个非中性的色彩分级通道都会被精确标记为阻断，避免发布后静默丢效果。

## 状态矩阵

| 参数 | WebGL | Studio Deep WebGPU | Deep Native | Native 发布行为 |
| --- | --- | --- | --- | --- |
| hue | 已消费 | 已消费 | 未消费 | 非 0 阻断 |
| saturation | 已消费 | 已消费 | 未消费 | 非 0 阻断 |
| brightness | 已消费 | 已消费 | 未消费 | 非 0 阻断 |
| contrast | 已消费 | 已消费 | 未消费 | 非 0 阻断 |
| temperature | 已消费 | 已消费 | 未消费 | 非 0 阻断 |
| tint | 已消费 | 已消费 | 未消费 | 非 0 阻断 |

中性状态（所有通道为零）继续走既有 Native 路径，不增加额外渲染成本。SSR 仍由原有精确阻断诊断处理。

## 变更与证据

- `apps/web/src/delivery/scenePublicationCompatibility.ts`：Native `postProcessing` 阻断条件覆盖六个色彩通道，并统一报告具体通道族。
- `apps/web/src/delivery/scenePublicationCompatibility.test.ts`：新增 hue 非零场景，验证发布预检返回精确阻断原因。
- 定向回归：`pnpm vitest run apps/web/src/delivery/scenePublicationCompatibility.test.ts`，16/16 通过。

正式 Native EXE、离线包及像素对拍仍属于最终全量验收，不由本次合同测试替代。
