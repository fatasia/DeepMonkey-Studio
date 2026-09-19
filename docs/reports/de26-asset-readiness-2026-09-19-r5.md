# DE26 资产就绪报告 — r5(2026-09-19)

对应门禁车道 `08-de26-asset-readiness`(主线门禁 `scripts/verify-mainline-closure.mjs`)。
本报告不覆盖 `docs/reports/de26-asset-readiness-2026-09-18.md`,而是接续其后的第五轮审计。

## 1. 本轮完成的事

1. 找到并固定两个 RVT 源文件的**真实身份**(哈希与 manifest 一致,SHA-256 现场复核):
   - `asset.bim.bimface-demo-1` → `D:\Download\BIMFACE示例模型.rvt`,6,459,392 B,`8087a360…3725fe`,Revit **2017**(build 20160225_1515 x64);
   - `asset.bim.snowdon-towers-arch` → `test-model\Snowdon Towers Sample Architectural.rvt`,94,691,328 B,`3327101091…5e44a1`,Revit **2024**(Autodesk 官方教学样本)。
2. 新增**源级统计探针** `scripts/fixtures/rvt-source-statistics.rs`(内置/本地/离线,基于仓内 vendored rvt-rs,Apache-2.0,Cargo.lock 固定):
   - 逐成员窗口化流式解码(32 MiB 窗口 + 64 KiB 尾部携带 + 绝对偏移去重),避免一次性大分配(本环境单次 ≥256 MiB 分配会直接 abort,r3/r5 均实测);
   - 2024 partition element-record 双轨道:**strict**(decode_at 全量验证,含 bbox)与 **headerRule**(仅头部同位验证 + ElemTable id join,不主张任何几何);
   - Snowdon 的 `Global/ElemTable` 布局是 2024 40 字节形态的**新变体**(+4 槽位为 u64 0x10 而非 FF 标记,库 `detect_layout` 回退 Implicit 导致 id 退化):探针按「record_count×40 + start 精确等于 inflate 总长 + 副主 id 不变式 + 单调性」做确定性再推导,任何偏差保持 fail-closed;
   - 审计编排 `scripts/audit-rvt-source-statistics.mjs`:离线构建、单测、双次运行确定性校验、诚实合同校验(`statistics.unmeasured` 必须显式声明 `triangles/meshes/textures`)。
3. 证据链:
   - `test-output/de26-rvt-source-audit-20260919-r5/`(evidence.json,scope=`source-statistics-aggregate`,含 reader/脚本哈希清单、每文件 `<sha>.json` 与复跑校验);
   - `test-output/de26-rvt-source-audit-20260919-r5/provenance.json`(来源 URL、哈希、版本、授权边界);
   - `test-output/de26-local-assets-readiness-20260919-r5/`(readiness.json / prepared-statistics.json / readiness-evidence.json)。

## 2. 源级实测数字(全部来自源 RVT 字节,非派生 GLB)

### BIMFACE 示例模型(Revit 2017)

| 阶段 | 结果 |
|---|---|
| BasicFileInfo | version=2017,build=20160225_1515(x64) |
| Global/ElemTable | **6,817 个声明元素 id**(库解析;该版本布局未证明,仅作声明清单) |
| partition 字符串层 | 42,739 条字符串记录;**3 个楼层名**;**136 个严格材质名**;1 个严格房间名 |
| partition element records | **fail-closed**(记录形态仅在 2023/2024 语料上证明,2017 不猜) |
| 几何 | 无(bbox/triangles 均未测量,不作主张) |

### Snowdon Towers Sample Architectural(Revit 2024 保存)

| 阶段 | 结果 |
|---|---|
| Global/ElemTable | 47,233 行精确拟合(`47233×40+30 = 1,889,350 B` 与 inflate 总长逐字节一致),**47,232 个声明元素 id**;副=主 47,148 行、副≠主 84 行、非单调 3 行、退化 1 行(全部如实报告) |
| partition 字符串层 | 126,878 条字符串记录(Partitions/68;2 个成员 deflate 损坏,偏移 3364345 / 86741554,如实记录);**3 个楼层名**;**646 个严格材质名**;18 个严格房间名 |
| partition element records(strict) | walls 6 / floors 1 / sketchLines 185(id-join 与 bbox 校验通过的子集) |
| partition element records(headerRule) | 结构性锚点:walls 1,235 / floors 197 / columns 186 / doors 289 / windows 165 / sketchLines 9,143;其中 id 能 join ElemTable 的:walls 6 / floors 1 / sketchLines 181 → **join-limited 导出实例:walls 5、floors 1** |
| sketch owners(仅 strict) | 43 个独立 owner id |
| 几何 | **instance-counts-only**:bbox 48 字节布局在该保存版本上未证明(出现非有限值/轴序不符),模型包络 withheld;triangles/meshes/textures 未测量 |

诚实结论:Snowdon 的主体元素记录存在(数千个与已证明 2024 形态同位的结构锚点),但该保存版本的 **bbox 布局与 record-id ↔ ElemTable join 未证明**,因此按类别精确实例集与几何包络保持 fail-closed;这不构成"不可解析即拒绝计费",而是精确记录了下一步逆向工作(bbox 轴序、id 空间映射、2 个损坏成员)。

## 3. 门禁 08 项状态

- `declaredStatus: unverified` 维持不变(两资产仍缺 `triangles/materials/meshes/textures` 源级实测,派生 GLB 统计继续标记 `authoritative: false`);
- gap 文本从笼统一句改为按资产的精确事实(见 closure.json 的 08 项);
- 源级统计现在有机器证据(`sourceRvtStatistics`),其中包含明确的 `unmeasured` 清单与失败点,替代"只有派生统计"的旧状态。

## 4. 剩余缺口

1. **Revit 2017**(BIMFACE):partition element-record 布局未证明 → 无法给出按类别实例数/几何;需要 2017 语料的记录形态逆向。
2. **Snowdon 2024 变体**:bbox 48 字节轴序与 record-id 映射未证明 → 按类别精确实例集与包络 withheld;2 个 deflate 损坏成员未解码。
3. **triangles/meshes/textures**:内置读取器无 tessellation,这些字段在源级长期保持 unmeasured,任何情况下不得用派生 GLB 统计冒充。
4. 上述任一进展都应在新证据目录(r6+)中推进,不覆盖本轮。
