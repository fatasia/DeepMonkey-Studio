# 3D Tiles S0：源码构建与解析资格检查

日期：2026-09-18。此项补足候选源码的构建与失败行为证据，不代表生产导入或几何验收完成。

## 结果

`3d-tiles-renderer@0.5.2` 的固定源码与 lockfile 在本机完成 `npm ci --ignore-scripts`、`npm run build-lib`。随后用本轮 npm 缓存完成 `npm ci --offline --ignore-scripts --no-audit --no-fund`，重新安装 561 个包并复构建。前后源码/构建入口逐文件哈希、lockfile、5 个正例和 6 个反例结果完全一致。此前“缺 npm 元数据”的状态已更新；依赖许可证闭包仍待核对。

使用 `format-fixtures/manifest.json` 中逐项核对长度与 SHA-256 的官方样本，实际调用上游 `traverseSet` 和 `B3DMLoaderBase.parse`：遍历 1 个父节点与 4 个子节点，5 个 b3dm 均提取出 GLB。样本内嵌的是 **GLB 1**，并非 GLB 2；本次未转换几何或验证渲染。

| 损坏输入 | 上游实际行为 |
| --- | --- |
| 魔数错误 | 仅 `console.assert`，继续返回 GLB |
| 版本改为 99 | 仅 `console.assert`，继续返回 GLB |
| 声明长度减 1 | 仅 `console.assert`，返回被截短的 GLB |
| 文件头截断 | 抛出 DataView 越界异常 |
| 正文截断 | 抛出 TypedArray 长度异常 |
| 表长度溢出 | 抛出 TypedArray 长度异常 |

前 3 项是必须在产品接入前补齐的严格预检，不得把控制台断言当成拒绝。后 3 项的原始异常也需要进入既有格式失败分类。

## 来源与复跑

- 解析器：`NASA-AMMOS/3DTilesRendererJS`，版本 0.5.2，Apache-2.0；本地固定源码目录 `data/external-assets/industrial-format-plan/build-trial/3dtiles-renderer`。
- 样本：`CesiumGS/3d-tiles-tools@4ca692eb16a9c7db21ec99e2aacc32645ce92f28` 的 `specs/data/Tileset`，Apache-2.0；沿用既有 6 项 manifest，不扩大授权范围至其他语料。
- 审计：`node scripts/fixtures/audit-industrial-tiles-source.mjs`。
- 证据：`test-output/industrial-tiles-source-20260918/evidence.json`，含逐文件源码/构建入口哈希、lockfile 哈希、样本解析结果、反例结果与运行环境。
- 离线重装复构建后的解析证据：`test-output/industrial-tiles-source-offline-20260918/evidence.json`。审计器只声明自身验证的解析范围；离线安装由上述实际 npm 命令单独验证。

首次实测源码总计 1,235,221 B，8 个构建入口共 5,622 B。入口只是重新导出源码，**5,622 B 不是安装体积**。本次 Node 进程峰值 RSS 为 60,132 KiB，包含审计脚本、哈希清单与解释器，不是独立转换 worker 的内存预算。

## 下一步

1. 离线重装和复构建已通过。新增生产依赖文件与许可证清单覆盖 9 个包、814 个文件；PMTiles 4.4.1 的 npm 包遗漏许可证，已从该包注册信息对应的官方提交 `0cebcaeade40034b86facb6e7da4ec726b9053fb` 补取，SHA-256 `0371c38f338835f7fc13ed71176f3d92144e22c8b736a31cced57adbbeb647b3`。其余 8 包附有许可证。证据 `test-output/industrial-tiles-licenses-20260918/evidence.json`；复跑 `node scripts/fixtures/audit-industrial-tiles-licenses.mjs` 不需要联网。可选 renderer peer、随包 notices 装配和逐文件例外人工核对仍待，不扩大为全分发许可闭包完成。
2. 严格 b3dm 容器预检已接入本实验解析前：5 个真实瓦片通过，6 个损坏样本全部抛错拒绝，另有 15 项边界测试通过。覆盖精确魔数（含高位字节）、版本、长度/预算、表 JSON/二进制引用、内嵌 GLB 头及尾部填充；GLB 1 和旧对齐明确列入诊断，仍只允许 inspect。证据 `test-output/industrial-tiles-preflight-20260918/evidence.json`，测试 `node --test scripts/lib/industrialB3dmPreflight.test.mjs`。生产 worker 接线与统一错误分类仍待，预检不代替几何和依赖闭包。
3. 新增隔离候选 `gltf-pipeline@4.3.1`（Apache-2.0），未加入产品依赖。5 个真实瓦片分别两次转换得到一致 SHA；每瓦片 240 顶点、120 三角，所有顶点属性和索引逐项不变。发现现有 NodeIO 拒绝 `CESIUM_RTC`，已按上游轴约定转换为标准父节点平移，保留局部 Float32 顶点和双精度平移，5 个产物均可由 NodeIO 实读；4 项轴向/共享根/坏引用测试通过。证据 `test-output/industrial-tiles-glb2-rtc-20260918/evidence.json`，脚本 `scripts/fixtures/qualify-industrial-tiles-glb2.mjs`。材质视觉、世界变换完整核对、feature 元数据、Tiles 层级运行时和候选许可闭包仍待；当前不升级生产资格。
4. 单独测量实际运行分发体积、冷启动及 worker RSS，补取消与预算行为。
