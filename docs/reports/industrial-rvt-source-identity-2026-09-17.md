# RVT 2024 源身份检查切片

新增可复跑的本地 RVT 源身份检查器，把选定分区记录绑定到源文件 SHA-256、ElementId、元素索引和实际字节位置。输出仅为 `inspect`，`geometry=missing`；未接产品转换 Provider，不生成包围盒 GLB。

## 范围与源码盘点

按 [权威工业计划](../specs/industrial-3d-format-work-plan-2026-09-16.md) WP-RVT 执行。现有产品 Revit Worker 依赖源软件，未用于本次检查。候选 `rvt-rs` 已在本地固定，原版源码实际编译成功，随后以 `--offline --locked` 独立重构建。

- 源码快照：`45134ecff49b`，不是把 v0.1.2 标签与 main 混为同一版本；包内 Cargo 版本也写 0.1.2。
- 固定源码归档 SHA-256：`c957d64e858f660cd1b5f4231bba481c6a5562dde21f0c50a147129ef1b44ca1`。
- Cargo.lock SHA-256：`11e7c905f9863ef534f9e787217a79aaeadd7c8d4548f1baa040fc3b8e8123c8`。
- 上游 `partition_element_records.rs` 明确把包围盒作为记录字段；`element_record_plan_profiles.rs` 从 sketch-line 包围盒推测轮廓端点；`partition_arc_walls.rs::thickness_feet` 始终返回 None。因此未直接接上游 GLB 导出来宣称真实建筑几何。
- 研究工具仅链接已固定 Apache-2.0 开源候选；未修改其源码、产品依赖或安装包。逐文件分发审计和正式 Worker 封装仍待完成。

## 实际语料与结果

原样本来源及授权见 [PLAN-01/02](../specs/industrial-format-plan01-02-lock-2026-09-16.md) 与本地 corpus-manifest。Core/Einhoven 来自已固定的 magnetar-io MIT 数据集；BIMFACE 为用户本地文件，仅本地验证，不主张再分发权。所有原模型和运行产物均未入库。

| 输入 | 实测版本 | 本检查器结果 |
|---|---|---|
| `2024_Core_Interior.rvt` | 2024 | 8 分区，187,598,597 字节解压内容；26,425 个索引声明 ID；选定 7 类 6,148 条记录、5,007 个源快照身份 |
| `D:/Download/BIMFACE示例模型.rvt` | 2017 | unsupported-version，0 个本 profile 身份 |
| `D:/Download/BIMFACE示例模型 (1).rvt` | 2017 | 与前件 SHA 完全相同，去重，不增加分母 |
| `Revit_IFC5_Einhoven.rvt` | 2023 | unsupported-version，0 个本 profile 身份 |

Core 的 5,007 个身份中，1,128 个对应多条分区记录，标记 `ambiguous-multiple-records`，不采用 first/last 胜出规则；3,879 个为 single-record。这些是墙/楼板/柱/门/窗/场地板/草图线的记录候选，包含类型及其它上下文，**不是 5,007 个已导入构件或全部模型分母**。

实际读取 ElementId、类别、container、placement 和诊断 bbox 字节，与 Reader 输出逐项核对。源身份为 `rvt:<sourceSha256>:element:<ElementId>`，确定性排序；只保证同一源快照，不声称跨修订身份。引用保留原值，关系语义仍为 unknown。

源 SHA-256：

- Core：`c805df445d613b408e37337765572021265e3f5dfdc7d1fa53b22ba1600b8014`
- BIMFACE：`8087a360173edaedf6d35992a8bbe7d4dc1904843024cec8f7d607cac73725fe`
- Einhoven：`d3a0c6d37d3f47a1726bc5aa7fe3880ed3c13bbe819b5e64680f6710b15aa948`

## 验证与失败方向

本地最终证据目录 `test-output/rvt-source-identity-20260917-final/`。每件双跑 JSON 哈希相同，源文件检查前后哈希不变。证据绑定 Rust 编译器、锁文件、全部候选源码、本项目检查器源码与 EXE。

- evidence.json SHA-256：`cca981d20085596f17f003b611d8a00c5629a5c4353f667d97de68ec9d611134`。
- Core 检查 JSON SHA-256：`f15d7a4674554245c8a5d9dc78af568739b512e8fba58df11484821c248c57ed`。
- 6 项 Rust 测试通过：ID 替换、截断、索引缺 ID、上下文字节变化、多记录保留、源快照命名空间、2024 索引偏移及错误容器。
- 真实 2017/2023 版本拒绝通过；非 CFB 文件与缺失文件退出失败；已有报告拒绝覆盖且 SHA 不变；治理门禁和 rustfmt 通过。
- 单输入 60 秒超时，子进程结束/中断清理，输入及单分区解压预算 256 MiB。不是经过恶意语料完整验证的生产沙箱，也未测量峰值 RSS。

首两轮检查因索引假设过严而失败，证据目录 r1/r2 保留：先误读主 ID 偏移 +12，校正为 +16/+36；随后发现 +4 的 8-byte 槽不总是 FF 哨兵。最终保留该槽原值、仅验证已确认 ID 字节，不赋予业务语义。Core 所选身份的索引引用中 4,127 条为非哨兵值。没有改源文件或放宽为几何成功。

解压的 gzip-like 失败偏移会记录，完整性始终 unverified；本件该列表为空也不表示所有格式字段已消费。当前 2024 样本只有一个，不足以升级通用版本支持。

复跑（在仓库根目录，输出目录须不存在）：

```powershell
./scripts/audit-rvt-source-identity.ps1 -InputFiles 'data/external-assets/industrial-format-plan/samples/rvt/2024_Core_Interior.rvt','D:/Download/BIMFACE示例模型.rvt','data/external-assets/industrial-format-plan/samples/rvt/Revit_IFC5_Einhoven.rvt' -OutputDirectory test-output/rvt-source-identity-repeat
```

## 真正通往几何的下一步

1. 以现有源身份/offset 锚定独立原始记录，解析元素记录长度、版本/活动状态和所属容器，解决多记录歧义，不能先选一个再补理由。
2. 2023 ArcWall 已有源位置/高度字段候选，但厚度缺失；下一可测试切片是 ElementId→type/WallType 的真实宽度字段关联及单位验证。拿不到厚度就保持线/参数检查，不设默认墙厚。
3. 2024 草图路线须直接读取曲线载荷（端点/曲线类型/参数域/闭环与孔），不能把 bbox 对角线作为曲线。只有源持久几何或完整可核验参数重建才进入 CAD IR/GLB。
4. 此后补至少两栋独立建筑、多学科/链接、世界坐标和开洞证据，再接内置 Worker、质量档与真实导入交互。当前不计 RVT 几何或产品完成。

engineering-taste 要求促成本片先核源码、再读真文件和失败反例；工程自检十项均按此窄研究范围为 9/10，不延伸为生产质量评分。无 UI/渲染修改，未进行视觉验收。
