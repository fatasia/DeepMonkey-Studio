# 素材与模型补量提质方案（达到行业主流水平）

状态：方案 v1（2026-09-04，响应用户指令"素材、模型、组件数量质量补足，达到行业主流水平，需要资源可以到网上下载、网上去找"）
归属批次：S3 扩展（`docs/platform-surpass-development-plan-2026-09-04.md`）

## 1. 数量与质量目标（行业主流口径）

| 类别 | 当前 | 目标 | 口径 |
|---|---:|---:|---|
| 3D 工业模型（可发布 GLB） | 1,482 | **3,000+** | 过审计门槛（缩略图/构图/哈希/许可），非"下载即计数" |
| HDRI 环境 | 12 套 | **40+ 套** | 工业室内外场景覆盖（车间/园区/黄昏/夜/阴天） |
| PBR 材质 | 16 套 | **60+ 套** | 金属/混凝土/油漆/锈蚀/塑料/标识常见工业面 |
| 2D 组件预设 | 156 | **300+** | 代码侧建设（ECharts 配方），非下载；含行业图元（管道/仪表/设备符号） |
| 看板模板 | 120 | **300+** | S3 行业深度包（每行业 5-10 页可编辑、可绑数据） |

质量底线不变（AGENTS.md §3.4）：只有来源、许可、结构、缩略图和质量门禁全过才进公共包；下载量不冒充商业质量。

## 2. 许可证红线

- **允许**：CC0（首选）；CC-BY 4.0（必须随 catalog 记录 attribution 并在素材详情展示）。
- **禁止**：CC-BY-NC / CC-BY-SA（产品分发与商用合规风险）、Fab/Quixel Megascenes EULA 资产、付费市场抓取、来源不明"免费下载站"。
- 每个 catalog 条目必须携带 `{ source, license, originUrl, attribution? }`，审计脚本对缺失字段直接阻断。

## 3. 来源目录（第一批，全部验证过许可模型）

| 来源 | 许可 | 内容 | 接入方式 |
|---|---|---|---|
| Poly Haven（api.polyhaven.com） | CC0 | HDRI、PBR 纹理、少量模型 | 公开 JSON API 枚举 + 直链下载 → `environment-materials` 通道扩展 |
| ambientCG（ambientcg.com） | CC0 | PBR 材质全套贴图 | 公开 API/列表直链 → `environment-materials` |
| Quaternius（quaternius.com） | CC0 | 低多边形工业/科幻/车辆/建筑包 | 固定 zip URL 镜像 → `open-packs` 通道 |
| Kenney（kenney.nl） | CC0 | 车辆、家具、工具、建筑套件 | 固定 zip URL 镜像 → `open-packs` |
| Poly Pizza（poly.pizza） | CC0 / CC-BY 混合 | 大量混合风格模型（按 tag 检索 industrial/factory/pipes/warehouse） | API 列表 + 逐条许可过滤（BY 带署名）→ `source-b` |
| Sketchfab API（仅 CC0+CC-BY 过滤） | CC0/CC-BY | 工业设备扫描与模型 | API 下载端点（需免费 token，存环境变量）→ `source-b` |
| NASA / Smithsonian 3D | CC0/公开 | 航天/科研（少量但合规） | 直链 → `source-b` |

搜索优先级：**行业相关度 > 数量**。工业缺口分类（泵/阀/换热器/配电柜/控制台/货架/叉车/AGV/传送带/钢平台/管道走廊）先查 Poly Pizza/Sketchfab，通用件用 Kenney/Quaternius 补。

## 4. 管线（复用既有，新增一个适配层）

```
来源适配器（新增 scripts/assets/fetch-cc0-source.mjs，按来源枚举+下载+写 manifest）
  → data/external-assets/<source>/ catalog.json（含 license/originUrl/attribution）
  → 既有审计链：pnpm assets:audit:external-models（GLB 结构+缩略图+构图+哈希+重复归并）
  → 既有发布门禁：assetQualityAudit / environmentAssetPublication（publicationStatus=review-required 默认）
  → 人工抽查（夜报附 top 排行与失败样本）→ published
```

- 新适配器支持 `--source polyhaven-hdri|ambientcg|quaternius:<pack>|kenney:<pack>|polypizza:<tag>|sketchfab:<query>` 与 `--limit N`；断点续传沿 catalog.json 已下载记录（既有 syncFile 模式照搬）。
- 下载并发 ≤8、单文件上限 200MB、总量按夜预算（默认 5GB）封顶；失败重试 2 次后记录不阻塞。
- 禁止把 CC-BY 署名塞进安装包外的地方丢失：attribution 进 catalog 并在资源中心详情页展示（复用 libraryOrigin 元数据结构，必要时扩展字段）。

## 5. 夜间执行集成

- 新 npm 脚本：`assets:sync:cc0`（适配器入口）、`assets:sync:cc0:report`（汇总当夜新增/通过/阻断/总量到 `test-output/nightly-<date>/assets.md`）。
- 排程：规格实现仍是夜间第一优先；**无待实现规格或完成仍有余时**，跑一轮 `assets:sync:cc0 --limit 200` + 审计 + 报告。下载属幂等操作，重复跑无害。
- 夜报只报事实：新增 X、通过审计 Y、阻断 Z（原因分布）、当前总量与目标差距；不宣称质量达标。

## 6. 首批执行顺序（写成规格供夜间/白天执行）

1. S3-A1：适配器骨架 + Poly Haven HDRI（纯 CC0、API 稳定、直接补 HDRI 目标缺口）。
2. S3-A2：ambientCG PBR（贴图套完整性校验沿 environment-materials 既有逻辑）。
3. S3-A3：Kenney/Quaternius 工业相关包镜像 + 分类映射。
4. S3-A4：Poly Pizza（tag=industrial 等，许可过滤 + attribution）。
5. S3-A5：Sketchfab CC0/CC-BY 工业设备（需 token，白天用户配置后启用）。
6. 2D 组件与模板扩容走 S3 本体（代码与内容建设，不走下载）。

## 7. 边界与诚实声明

- 不用生成式 3D 冒充真实资产；不用下载计数冒充商业质量；每个"可发布"状态都有审计记录。
- 若公开 CC0 生态无法覆盖某工业分类（如特定品牌设备），记录为缺口，不引入仿冒品牌模型（品牌风险门禁继续生效）。
