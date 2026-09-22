# DE26 资产 / readiness 证据（2026-09-18）

这份报告只回答“当前资产能否进入可复现基准和素材准入”，不把本地文件存在、静态合同或 GPU 未执行提升成完成。

## 复现

```powershell
pnpm exec vitest run packages/deep-engine/src/benchmarkReadiness.test.ts
pnpm --filter @bim-studio/deep-engine typecheck
pnpm exec tsx scripts/prepare-de26-local-benchmarks.mts test-output/de26-local-assets-readiness-20260918
pnpm exec tsx scripts/inspect-de26-local-benchmarks.mts test-output/de26-local-assets-readiness-20260918
node scripts/verify-de26-readiness-evidence.mjs test-output/de26-local-assets-readiness-20260918
node --test scripts/lib/kenneyNatureAdmission.test.mjs
```

最后一条命令只验证 V11 准入逻辑；readiness evidence 命令汇总覆盖率和缺口，但不会把派生 GLB 统计升级为 RVT 源统计。前两条是纯合同/类型门禁，后两条读取本机源文件并写入 gitignored 的 `readiness.json` 与准备包。资产字节不进仓库。

## 结果

机器清单：[de26-asset-readiness-2026-09-18.json](../specs/de26-asset-readiness-2026-09-18.json)。本轮生成的完整运行产物为 `test-output/de26-local-assets-readiness-20260918/readiness.json`。
该 JSON 由当前 8 份场景角色清单重新生成；源文件哈希和字节数均由脚本复算，文件不含运行时刻或随机字段，可在同一输入上复算。
覆盖率与缺口机器包为 `test-output/de26-local-assets-readiness-20260918/readiness-evidence.json`；本轮负载类覆盖为 `6/6`，任务种类覆盖为 `4/4`（含真实电池 GLB 的 animation clip fixture），状态从 `blocked` 前进为 `unverified`。剩余唯一缺口是两个 RVT 的源级精确几何/材质统计；`derivedStatistics.authoritative=false` 仍是硬边界。

| 检查 | 状态 | 证据边界 |
|---|---|---|
| 最少真实资产数（≥3） | measured | 当前 8 份场景角色清单 |
| 8 份 manifest 合同、唯一身份 | measured | `benchmarkAssetManifest` v1 校验通过 |
| 3 条轨迹合同与非 dashboard 任务引用 | measured | `trajectories-v1.json` + `benchmarkAssetTrajectory` v1 |
| appearance / animation / dashboard 任务覆盖 | measured | 电池 GLB 的真实 `Animation.001` 已登记为 animation fixture |
| 8 份本机源字节数/SHA-256 | measured | inspect 脚本逐文件读取并复算 |
| 冷/热缓存声明、许可边界 | measured | 5 份清单均显式声明；不可再分发源保持 local-only |
| A02 六类负载覆盖 | measured | 6/6；重复源按不同场景角色登记，不复制或修改源字节 |
| RVT 精确几何/材质统计 | unverified | 两个 RVT 仅有源身份，未用文件大小或估算冒充统计 |
| V11 Kenney Nature 准入 | blocked | `fence_gate.glb` 的 `minY=-0.1702811569` 越过 `|minY|≤0.001m` |

准备脚本生成的两个本地派生包保留全部源实例和材质，仅做固定版本 Draco 解码/dequantize 与相机帧记录；`LocalBim` 为 651 geometry / 651 instances，`LocalPreheater` 为 204 geometry / 213 instances。远原点设备使用 authored `group2` 聚焦相机，不能把全场景包围球当作可见性或性能结论。

## 代码门禁

`benchmarkReadiness.ts` 对 manifest、trajectory、源 hash、任务引用、统计完整性、缓存条件和许可边界分别出具 `measured` / `blocked` / `unverified`。缺观测只会是 `unverified`；hash 不符、悬空 fixture、缺必需负载类会是 `blocked`。该层不读取 GPU，也不生成分发许可或产品接线结论。

V11 继续复用 `kenneyNatureAdmission.mjs` 的 grounded-origin fail-closed gate。清除异常记录会被测试拒绝；真实拖放、旋转/缩放/复制/删除、保存刷新重开和连续铺设仍未验证。

## 下一步

通过批准的本地解析链测量两个 RVT 的几何统计；V11 仍需现有 prefab catalog 和真实场景操作验收。DE26 readiness 不再因负载类或 animation fixture 阻断。
