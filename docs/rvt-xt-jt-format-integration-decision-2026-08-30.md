# RVT、Parasolid X_T 与 JT 工业格式接入决策（2026-08-30）

> 后续设计：用户于 2026-09-16 要求规划三类格式的内置离线高保真支持，见 [JT、X_T、RVT 接入方案](./specs/jt-xt-rvt-offline-integration-plan-2026-09-16.md)。新文档是实施方案；本页保留历史决策与已实现能力，不表示新解析器已接入。

## 结论

三类格式进入产品，但采用“源文件保留 + 可替换转换器插件 + 轻量运行时产物”的方式，不在浏览器或 API 主进程中复刻完整 CAD/BIM 内核。

- RVT 的首选正式路径继续使用项目自研 Revit Worker/Add-in，输出原生 GLB 或 IFC、层级和属性；它不增加第三方 SDK 依赖，但转换机必须安装并合法授权 Autodesk Revit。
- 无 Revit 的服务器或云环境，可选 ODA BimRv 或 Autodesk APS Design Automation。两者都是有许可/服务依赖的正式方案，不能描述为“无依赖直读”。
- Parasolid `.x_b` 与 JT 的正式路径使用可替换的商业 SDK 适配器。`.x_t` 另有 2026-08-31 新增的自研 V24.1 单体共轴旋转体子集；超出该严格签名的 X_T 仍需商业 Provider，不能外推为通用直读。
- 公开格式参考并不等于存在生产级开源解析器。未发现能够同时覆盖版本兼容、装配树、PMI、精确 B-Rep、压缩变体和恶意文件防护的无依赖开源实现，因此不把实验解析器放进主链路。
- 浏览器只消费 GLB、`hierarchy.json`、`properties.json` 和可选 `pmi.json`；源文件始终保留用于复转、审计和未来更换 Provider。BIM 得到增强，但产品不变成 RVT/Parasolid/JT 编辑器。

## 为什么 Unity 能支持，而我们仍需要商业依赖

Unity 的工业格式能力来自 Pixyz/Asset Transformer，而不是 Unity 运行时天然解析 RVT、JT 或 Parasolid。Unity 官方旧版 Pixyz 格式矩阵明确列出 RVT、JT 和 Parasolid，当前 Asset Transformer 文档同样要求相应插件与许可证。这证明“Unity 可接入”成立，但也证明正确复刻对象是转换工作流、优化和运行时资产，不是重写这些私有格式内核。

## 证据矩阵

| 路径 | RVT | X_T | JT | 装配/属性/PMI | 许可与部署判断 |
| --- | --- | --- | --- | --- | --- |
| 自研 Revit Worker | 是 | 否 | 否 | RVT 层级与属性；可输出 GLB/IFC | 代码自研，运行时需要合法 Revit；当前首选 |
| Autodesk APS Design Automation | 是 | 否 | 否 | 由 Revit Add-in 决定 | 云服务依赖；适合无本地 Revit 的按需任务 |
| ODA BimRv | 是 | 否 | 否 | Revit 数据、几何和导出 | 商业 SDK；适合独立服务端直读 |
| HOOPS Exchange | 是 | 是 | 是 | 装配、可视化、B-Rep、PMI、元数据 | 商业 SDK；单一接口覆盖三类格式，优先评估 |
| CAD Exchanger SDK | 是 | 是 | 是 | B-Rep、Mesh、装配、元数据、PMI | 商业 SDK；格式可按需授权，作为第二候选 |
| Siemens PLM Components | 否 | 是 | 是 | Parasolid 精确几何、JT 装配/PMI/元数据 | 商业组件；适合已有 Siemens 采购体系 |
| OCCT 开源核心 | 否 | 否 | 否 | 不覆盖这三类正式导入 | OCCT 官方将 JT/Parasolid列为商业 Data Exchange Components |

官方依据：

- [ODA BimRv SDK](https://www.opendesign.com/products/bimrv) 与 [BimRv FAQ](https://www.opendesign.com/faq/bimrv)
- [Autodesk APS Automation APIs](https://aps.autodesk.com/automation-apis)
- [HOOPS Exchange 支持格式](https://docs.techsoft3d.com/hoops/exchange/start/supported-formats.html) 与 [JT Reader 能力](https://docs.techsoft3d.com/hoops/exchange/start/format/jt_reader.html)
- [CAD Exchanger 支持格式](https://cadexchanger.com/formats/) 与 [SDK 授权说明](https://cadexchanger.com/products/sdk/pricing/)
- [Unity Pixyz 支持格式存档](https://www.pixyz-software.com/documentations/archives/plugin/2022.1/SupportedFormats.html) 与 [Unity Asset Transformer 导出说明](https://docs.unity.com/en-us/asset-transformer-sdk/2026.4/manual/io/export-files)
- [OCCT 官方 Data Exchange Components 说明](https://github.com/Open-Cascade-SAS/OCCT/discussions/1157)
- [Siemens JT v10 文件格式参考](https://www.plm.automation.siemens.com/en_us/Images/JT-v10-file-format-reference-rev-B_tcm1023-233786.pdf)

## 已落地的产品边界

- 上传入口接受 `.rvt/.x_t/.x_b/.jt`。JT 会读取版本、TOC、LSG 层级、属性、材质和可安全译码的 TriStrip/TopoMesh；只有存在完整 LOD0 且生成的 GLB 通过三角几何审计时才进入 `ready`，否则停在 `waiting_converter` 且没有几何 URL。RVT/X_B 缺失 Provider 时等待；X_T 只有命中真实样本签署的 V24.1 子集才生成 GLB，其他有效文本结构保留检查证据并等待。
- 等待状态按格式明确显示 Revit、Parasolid 或 JT 转换器，不再把 JT/X_T 误导为“等待 Revit 转换机”。
- `/api/converters` 返回版本、输入、结构化产物、资源上限、部署位置、检测状态和修复动作。
- 转换任务支持提交、查询、取消、AbortSignal、输出路径约束、大小上限和 SHA-256 产物指纹。
- Capability 与 MCP 共用 `model.conversion.catalog/submit/status/cancel`；AI 开发者不能获得任意 shell 或对象存储权限。
- Server SDK 提供类型化的转换器目录、任务提交、列表、状态和取消方法。
- JT/X_T 正式适配器至少必须生成 `geometry.glb` 与 `hierarchy.json`；属性和 PMI 存在时分别保存在 `properties.json`、`pmi.json`。质量默认 `high`，不通过自动降质换取导入速度。

## 供应商验收门槛

商业 SDK 不是买来即完成。候选 Provider 必须在同一受控语料上通过：

1. RVT 2019–当前受支持版本、JT 8–10 常见变体、Parasolid 文本/二进制版本矩阵。
2. 单件、深层装配、外部引用、重复实例、隐藏状态、单位、坐标、材质、属性、PMI 与多 LOD。
3. 几何包围盒、体积/面积（可用时）、实例数量、装配路径、PMI 关联和固定视角截图对照。
4. 2 GB 输入、超时、取消、转换器崩溃、无许可证、损坏文件、路径穿越和压缩炸弹故障注入。
5. 同一输入哈希、Provider 版本和配置产生可追溯产物；升级 Provider 前后保存差异报告和回滚能力。

没有通过这组门槛的 Provider 只能标为试用或研究，不进入默认生产链路。
