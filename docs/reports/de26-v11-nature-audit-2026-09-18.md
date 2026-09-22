# DE26/V11 Kenney Nature Kit 机器核验

证据文件：`test-output/de26-v11-nature-review-20260918/geometry-units-thumbnail-audit.json`。

运行的只读审计命令使用 `nature.zip` 的 SHA-256 `fa7974a0d342bfe63c38664ba9f8ec1a4aab8ea25f099bdc56870e33588c4d9d`，通过 `zipfile` 读取 GLB JSON/BIN，不转换、不重建素材链。压缩包含 329 个 GLB、1640 个 PNG 和 1 个 License 文件；当前筛选的树木、灌木、围栏、地面各 12 个，共 48 个，全部具有 float32 `POSITION`，非有限坐标为 0。

48 个筛选模型均能找到至少 4 个 `Isometric/*_NE/NW/SE/SW.png` 视图，但 GLB 本身没有嵌入图片（材质使用 `baseColorFactor`），所以缩略图仍需产品目录注册，不能把压缩包内 PNG 视作已接入 UI。几何尺寸处于约 0.2–2.1 的无量纲范围，支持“米制假设”但不能单凭 GLB 证明单位合同。

落点审计发现一个明确异常：`fence_gate.glb` 的顶点 `minY=-0.1702811569`；其余选中围栏以及 12/12 树、12/12 灌木、12/12 地面均以 `minY≈0` 落地。该文件应在素材准入时显式做原点偏移或标为待修，不得静默当作已贴地素材。

本轮已生成显式派生修正版：保留源文件 SHA `34d10d5620179b8a211a01eea837caa828c0782422f0b408e1a5838788888436`，对 POSITION 几何统一增加 `0.17028115689754486m`，派生文件 `test-output/de26-v11-nature-review-20260918/derived/fence_gate-grounded.glb` 的 `minY=0`，证据见同目录 `derived/fence_gate-grounded.json`。这只解决几何准入异常；目录注册、真实拖放、保存刷新重开和连续铺设仍未验收，V11 继续保持 `review-required`。

当前仍未完成产品内真实场景拖放、旋转/缩放/复制/删除、保存刷新重开和连接点连续铺设；因此状态保持 `review-required`。本审计不修改共享 clipping 或场景状态链。

素材同步复跑发现 `city-kit-industrial` 的历史 ZIP 直链返回 HTTP 404，但资产页 `https://kenney.nl/assets/city-kit-industrial` 返回当前 `kenney_city-kit-industrial_2.0.zip`（HTTP 200）。同步器现已在该类 404 时回资产页解析 ZIP，并将单包失败记录为 `syncError` 后继续其余包；17 包缓存复跑完成，目录总量 87.7 MiB。404 不再中断整批同步。

准入门禁已固化为机器可读清单 [`de26-v11-kenney-nature-admission-manifest-2026-09-18.json`](../specs/de26-v11-kenney-nature-admission-manifest-2026-09-18.json)，并由 `scripts/lib/kenneyNatureAdmission.mjs` 执行 fail-closed 的 grounded-origin fence gate。聚焦测试：`node --test scripts/lib/kenneyNatureAdmission.test.mjs`（2/2）；当前 `fence_gate.glb` 越过 `|minY| ≤ 0.001m` 门槛时明确保持 `blocked`，清除异常记录会被拒绝。

2026-09-19 复核：`node scripts/verify-v11-grounded-derived.mjs` 成功重读派生 GLB（`rawMinY=0`，SHA-256 `5c8a7e6f730bd096a71dd0ce867b495be5f5a08b85579905c52aace9f895b8a3`），准入单测仍为 2/2。该复核只证明派生几何满足落点门禁，不改变产品内目录注册、拖放和保存刷新重开仍未验收的结论。
## 2026-09-19 staging

已将 48 个准入 GLB 与 192 个四视图缩略图整理到 `apps/web/public/assets/nature-kit/`，并生成 `catalog.json`。`fence_gate.glb` 使用已审计的 grounded 派生件，源 hash 保留在 catalog；原始 329 个 GLB 未进入发布目录。该 staging 只证明资源可发布，产品拖放/插入/保存刷新重开仍需真实场景验收。
