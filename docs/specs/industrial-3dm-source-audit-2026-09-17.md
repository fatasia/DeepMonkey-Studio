# 3DM 开源读取与源身份实验

本实验验证 Windows 本机 openNURBS 读取真实 3DM、导出可审计网格和实例信息。产品依赖、路由与能力等级没有改动。

## 已完成

- 现存 VS2022 Community 17.14.12 / MSVC 14.44.35207 可用；PLAN-02 的“本机无 MSVC”仅是旧盘点结果，不再成立。
- 官方 openNURBS `v8.35.26251.13001` 原码构建成功，无源码补丁。命令覆盖上游 v142 为 v143，目标为 `Examples\example_read`；上游依赖图同时构建静态库、DLL 与 zlib。
- 官方 example_read 与新增独立 JSON 审核程序均读通三份锁定真实样本。不存在商业 CAD、转换 SDK、在线授权运行依赖。
- 原始网格输出位置和三角索引；四边形按 `(0,1,2)`、`(0,2,3)` 拆分。对象 UUID、图层及父层 UUID、单位与米比例、材质索引/来源和材质身份保留。实例定义成员及引用的行优先 4×4 变换保留。

## 复现

仓库根执行：

```bat
scripts\fixtures\build-3dm-source-audit.cmd
node scripts/fixtures/audit-3dm-source.mjs
```

构建脚本通过官方 `vswhere` 定位包含 MSVC x64 工具的最新 VS 安装，不是产品安装器。首次使用错误目标 `example_read` 报 MSB4057；直接编译 vcxproj 缺少静态库。最终使用上游解决方案的目录限定目标解决，无需更改工程文件。独立程序链接补齐 Windows 系统库 shell32，未新增第三方库。

源缓存：`data/external-assets/industrial-format-plan/dependencies/extracted/`。openNURBS 源码归档 SHA-256 为 `95e8ba3c9374c48bc2353bb7c8eabc180a4eccc764c305257c9c8f81d147668d`；rhino3dm v8.32.0 归档为 `eca07a748eb26f148024eadb7524daa056f2dbe49fcde9511ee7290f5ca00a5a`。

官方样本来源：[rhino3dm v8.32.0 tests/models](https://github.com/mcneel/rhino3dm/tree/v8.32.0/tests/models)。原件和产物仅存 gitignored 本地研究目录，不分发；rhino3dm MIT 和嵌入 openNURBS 的逐文件分发审计仍按 PLAN-01 执行，不构成商业许可证依赖。

| 样本 | SHA-256 | 源对象 / 定义 / 引用 | 输出顶点 / 三角形 |
|---|---|---:|---:|
| mesh.3dm | `59e78629c5c19a5e04a195d746cd6b3981c504fcdcd76423ba507ec9e58e69b7` | 1 / 0 / 0 | 420 / 276 |
| blocks.3dm | `1e428317489c7c22ee68fb93e119079c718a0ba44efa7c89efb10cf0d8491cb8` | 6 / 1 / 2 | 0 / 0 |
| meshWithTexture.3dm | `6d0f789c626990784171758d29e6e616ba7a7e36e0018f9f45bc22bd011a9cb1` | 1 / 0 / 0 | 92 / 180 |

三件均为 archive version 80。meshWithTexture 含 100 个源面，其中 80 四边形，拆分得 180 三角形。blocks 的 1 个 Brep 面无储存 render mesh；其余不支持对象明确输出 `unsupported`，没有合成替代几何。实例身份和变换验证成功不代表 block 可完整渲染。

## 验证与产物

`test-output/3dm-source-audit/evidence.json` 记录逐源 SHA、输出 SHA、官方读取器 SHA 和自建 exe SHA。每次运行核对读取前后源 hash、JSON 可解析、重复提取逐字一致、UUID 唯一、图层引用、有限坐标、三角索引范围、四边形拆分计数、实例定义/成员引用与环路。三件文件截去后半部分均非零退出且 stdout 为空；缺失文件同样拒绝。三件正常样本 stderr 均为空。

JSON 为源局部坐标，未烘焙实例变换；`matrixRowMajor` 明确布局，后续可复用同一网格。JSON 程序使用 ONX_Model、ON_ModelGeometryComponent、ON_Mesh、ON_BrepFace::Mesh、ON_InstanceDefinition::InstanceGeometryIdList 和 ON_InstanceRef，不重写 3DM 解码器。

官方 example_read 3,418,112 字节，静态库 50,908,458 字节（含链接时优化对象，不是最终包体）。本次 exe hash：

- 官方读取器：`df7ec6d92f54f5cf6c30a9c06486a3bba27f8654212c50d126985b54de9fe8d0`
- 独立审核程序：`c0599c85ec93d9897743b422ce290a02f38ab2223994907badd949c6d8399626`
- 证据报告：`78885fa50e567b6f7849f04a45767cd005f19b6fb6cdd42170051f0f9099b638`

独立程序链接使用 `/Brepro`；连续两次重建的 SHA-256 一致。确定性只覆盖当前固定源码、工具链和参数，不宣称跨编译器版本 bit-for-bit 相同。

上游构建有 C4819 源码页、C4189 未使用局部变量、LTCG 中 C4756 常量溢出警告。没有据此宣称无警告构建；本次真实读取和导出断言通过。

## 本轮待办

本切片仍是研究 `inspect`：未导出法线/UV/纹理/PBR 外观，材质仅身份和归属；未做几何外观验收、实例变换烘焙、外部 block 文件依赖、任意损坏文件与资源预算。四边形固定对角线只验证本样本，不代替非平面或凹四边形质量验收。下一最小纵向切片是将已验证 mesh 数据接入现有 GLB 导出/源身份审计；无缓存 Brep 继续显式保持缺几何状态。
