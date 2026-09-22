# RVT：26 个真实平面实体，同族扫描结果

面向 RVT 本地几何桥的研究验证。2024 Core Interior 中，26 个独立楼板/场地板已由持久化平面和双侧 UV 共边生成闭合实体；不是整楼支持。

## 范围和结果

沿用 [首个实体解析](industrial-rvt-planar-solid-2026-09-18.md) 的六平面、十二边、八顶点规则。解析器不固定 Element 21975；支持已观察到的 `3f08d501` 和 `3f08d700` 载荷标记。扫描只覆盖 Floor / Building Pad 元数据，未将其他类别计入分母。

| 结果 | 源身份数 | 处理 |
|---|---:|---|
| 独立实体成功 | 26 | 导出真实世界坐标 GLB |
| 复杂载荷未支持 | 52 | 拒绝生成实体 |
| 同身份多个不同几何记录 | 22 | 拒绝选择任意版本 |
| 容器成员、世界放置未解 | 26 | 不以局部坐标冒充世界坐标 |

共 126 个候选身份，其中 100 个独立候选；成功率 26/100 仅用于此类别和此样本。148 条元数据记录和 148 条几何记录已保留。52 条符合 3704 字节布局的记录都能通过平面/共边解析，记录数含重复分区载荷，不能当唯一实体数。26 个容器成员中只有 14 个具有已支持简单 BRep，另 12 个为复杂载荷。后续组引用证据见 [容器实例报告](industrial-rvt-group-placement-2026-09-18.md)。

成功身份：29346、29421、20345、20946、22756、22789、25402、25477、55252、55327、58887、59710、59768、60591、60649、61472、61530、62353、62411、63234、63292、64115、65238、70359、70508、21975。

## 几何证据

- 全部 26 个实体分别保留 6 个源面、12 条源边、8 个顶点和 12 个三角形，共 312 个三角形。
- 全部通过有向边双侧闭合、正体积、Float32 无塌缩检查；量化后体积相对偏差小于 `1e-5`。
- 独立重读 GLB 与源 BRep 顶点逐一比较，最大三维坐标误差 **0.0013782735644082007 mm**，门槛仍为 **0.01 mm**。
- 每个实体都有同源身份的四条真实曲线作 XY 轮廓复核。草图 Z 与实体放置关联仍未解决；实体上下界取持久化平面，不取草图 Z、bbox 高度或默认厚度。
- 清零各记录 bbox 字节后，26 个解析结果的顶点完全相同。未支持孔洞或多轮廓的实体保持拒绝。

两个测试文件共 **5/5 通过**：`scripts/rvt-planar-prism.test.mjs`、`scripts/rvt-planar-family.test.mjs`。其中包含错误源身份、损坏载荷、非有限平面、单侧 UV 错配和实际 GLB 拓扑检查。最终 Rust 源码重新离线编译，重新扫描输出 SHA 与前一轮完全相同。

## 证据和复核

源文件：`data/external-assets/industrial-format-plan/samples/rvt/2024_Core_Interior.rvt`。
源 SHA-256：`c805df445d613b408e37337765572021265e3f5dfdc7d1fa53b22ba1600b8014`。

本地证据：

- `test-output/rvt-planar-family-source-20260918-r2.json` 与 `...-final-repeat.json`：SHA `e430f5d8a4c9abfc89abec1330e74c163f921b3fb2a3909dab360b2d63ef88ba`。
- `test-output/rvt-planar-family-20260918-v2/evidence.json`：逐身份支持与拒绝原因、单实体 GLB 哈希。
- 同目录 `partial-source-solids.glb`：SHA `e405afcada8e4418cb7790362c84fbbaf10eb3353ffd8e2a44e35221ec20f271`。
- 同目录 `visual/`：三个实际 GLB、两轮六张 Chrome 截图和实际加载面数证据。

生成命令：

```powershell
test-output/rvt-planar-solid-source-final.exe data/external-assets/industrial-format-plan/samples/rvt/2024_Core_Interior.rvt all <new-source.json>
node scripts/audit-rvt-planar-family.mjs <new-source.json> test-output/rvt-source-curves-20260918-v2/profiles.json test-output/rvt-source-curves-20260918-v2/source-lines.json <new-output-directory>
```

测试环境变量为 `RVT_FAMILY_OUTPUT`、`RVT_PRISM_PROFILES`、`RVT_PRISM_LINES`；首实体测试另需 `RVT_PRISM_SOURCE` 和 `RVT_PRISM_GLB`。证据不存在时测试失败，不跳过。

## 实际 GLB 视觉检查

复用 SolidWorks 源网格诊断页，只适配 RVT 标签、源 Z-up、令牌材质与雾；未新建产品查看器。26 实体聚合、21975 厚场地板、70508 薄楼板各做两轮：1280×800 和 980×800、相反观察方向。六张截图已逐张查看；无裁切、无浏览器错误，源身份和三角数量正确。薄楼板按真实厚度显示，没有放大厚度改善观感。

采用 design-taste-digitaltwin 的两轮检查方法；对标西门子的克制诊断信息和 Unity 的 ACES/PBR 基础。此处是几何诊断，不是产品视觉完成验收。自评：布局 9、字体 9、令牌一致性 9、信息层级 9、几何可辨识性 8、光照层次 8、尺寸适配 9、状态准确性 9；交互动线和动效不适用。近邻白色楼板缺少阴影分层，浅色主题未验证，因此不声明达到完整 Kimi-95 或 Unity 渲染水位。

## 剩余边界

此结果来自同一份真实建筑文件的 26 个实体，不是 26 份独立模型。2023 Einhoven 尚未通过此 2024 载荷解析器验证，版本拒绝仍保留。下一片应解析容器放置或复杂楼板的孔洞/边环；不能把当前局部 GLB 当整楼导入成功。本片保持 `preview`，未修改生产导入能力标记。
