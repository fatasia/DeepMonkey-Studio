# 工业 S0 收尾证据盘点（七方向 × 样本/依赖/失败分类/体积RSS）

日期：2026-09-17。性质：**只读盘点 + 证据索引**，不新增实测数据；所有结论指向既有证据路径。
权威计划：[industrial-3d-format-work-plan-2026-09-16.md](./industrial-3d-format-work-plan-2026-09-16.md) 第 5 节 S0 门槛 =「七方向各有输入、依赖清单、失败分类和体积/RSS记录」。
样本登记：`data/external-assets/format-fixtures/manifest.json`（本日补齐 13 条，含本次新增 jt coffee-maker 条目）。

## 1. 本次补登记

- `jt/voyager-coffee-maker-jt9.5.jt`：文件在库、manifest 未登记，已按既有条目形状追加。
- SHA-256 实算 `ea7a1ecb…40c46172`（sha256sum），bytes 590886，与 [jt/README.md](../../data/external-assets/format-fixtures/jt/README.md) 表格一致；上游 `src/main/resources/9.5/CoffeeMaker.jt` @ `cab63070`（本地 git blob `32fbaa4b…` 与上游 tree API 一致）。`jt/README.md` 无需更新。

## 2. S0 矩阵（每格给证据路径；「缺」= 未找到证据，不从代码推断）

| 方向 | 样本 | 依赖清单（库名+版本） | 失败分类证据 | 体积/RSS/冷启动记录 |
| --- | --- | --- | --- | --- |
| JT | 有（2 份）：manifest jt×2（9.5 CoffeeMaker 590886B + 10.3 ExampleBlock 10330B）；缺口：LOD/B-Rep/PMI/多文件版本矩阵（[PLAN-01/02 §3](./industrial-format-plan01-02-lock-2026-09-16.md)） | 有：仓内 `@bim-studio/jt-reader` 0.1.0（DMCSL-1.0，同上 §2） | 有：无关材质拒绝/`missing`/`ambiguous`（[材质路径报告](../reports/industrial-jt-material-path-2026-09-17.md)）；坏路径/循环/重复拒绝 23+27 测试（[身份报告](../reports/industrial-jt-occurrence-identity-2026-09-17.md)，`test-output/jt-occurrence-before\|after/`） | **缺**：报告仅顶点/三角数，无安装体量、冷启动、峰值 RSS |
| 3DM | 有：manifest 3dm×2（openNURBS V5/V6 官方例）+ PLAN-01 语料 openNURBS V1–V8×153、rhino3dm×13（PLAN-01/02 §3） | 有：openNURBS v8.35.26251.13001（[MSVC 构建成功](./industrial-3dm-source-audit-2026-09-17.md)；MinGW 失败记录 [PLAN-02 §3](./industrial-format-plan02-build-trial-2026-09-17.md)）；rhino3dm v8.32.0（submodule 空，PLAN-02 §5.4） | 有：截断文件非零退出、缺失文件拒绝（3dm-source-audit；`test-output/3dm-source-audit/*.truncated`、`evidence.json`） | 部分：静态库 50,908,458B、example_read 3,418,112B（3dm-source-audit）；**RSS/冷启动缺** |
| X_T | 有（最厚）：manifest x_t×1 + 109 份 Asmith 真实样本 + parasolid-kit corpus×10（PLAN-01/02 §3.1） | 有：parasolid-kit v0.2.0（构建+159 测试，PLAN-01/02 §2）；研究链 cadconvert native @ `73b37836`（§4） | 有：`schema.missing_base_schema` 拒绝、60 parse-error/109 incomplete 审计、NaN clamp panic、24/25 面差额与修复（PLAN-01/02 §3.2/§4/§6；[legacy-stream](./industrial-xt-legacy-stream-2026-09-17.md)、[distance-panic](./industrial-x-t-distance-panic-2026-09-17.md)、[shell-chain](./industrial-x-t-shell-chain-2026-09-17.md)；`test-output/xt-native-corpus-fixed/evidence.json`） | 部分：输出 64,489,700B、P50 60.05ms/P95 1109.78ms（PLAN-01/02 §6，原文声明"不是冷启动/峰值 RSS 认证"）；**RSS/冷启动缺** |
| RVT（inspect/blocked） | 有：manifest rvt×1（BIMFACE 2017，仅本地不分发）+ PLAN-01 2 份 MIT RVT（Core 2024/Einhoven 2023）+ 37 份本机盘点（PLAN-02 §6） | 有：rvt-rs v0.1.2（快照 `45134ecff49b`，MSVC 离线重构建成功，[源身份报告](../reports/industrial-rvt-source-identity-2026-09-17.md)） | 有：unsupported-version 2017/2023 拒绝、非 CFB/缺失文件失败、索引偏移假设 r1/r2 失败保留（同上；`test-output/rvt-source-identity-20260917-final/`） | 部分：8 分区 187,598,597B 解压内容（同上）；原文"未测量峰值 RSS"——**RSS/冷启动缺**；仅 inspect，geometry=missing |
| SolidWorks（blocked） | **缺真实样本**：仅 cadmpeg 21 合成 SLDPRT fixture（PLAN-01/02 §3） | 有（候选级）：cadmpeg v0.6.0 已下载校验；**离线构建失败**（clap 元数据缺失，PLAN-02 §5.5） | **缺**：无任何格式级失败分类测试执行证据 | **缺**：未产出构建物 |
| 点云 E57/LAS | 有：manifest las×1（PDAL 1.2-with-color.las）+ PLAN-01 E57×21、LAS/LAZ/COPC×10、lazperf×23（含正反例语料） | 有：laz-perf 3.4.0 构建成功（PLAN-02 §4）；libE57Format v3.4.0 **被 XercesC 3.2 阻断**（§5.1）；PDAL 2.10.2 源码包未锁定（§5.3） | 部分：构建级失败有记录（缺 XercesC/离线 cargo）；**格式级损坏反例回归执行证据缺** | 部分：laz-perf readlaz 峰值 RSS 6.9/14.6 MB（1ms 轮询近似，PLAN-02 §4.3）——**七方向唯一 RSS 实测**；E57 侧缺 |
| 3D Tiles | 有：manifest 3d-tiles×6（官方 Tileset+5 b3dm）+ PLAN-01 222 文件/9 tilesets；**222 件语料许可未声明**，仅可内部评估（PLAN-01/02 §3/§5） | 部分：3d-tiles-renderer v0.5.2 **离线阻断**（缺 npm 元数据，PLAN-02 §5.2）；无可离线构建 C++ 候选 | **缺**：无解析/遍历失败分类测试 | **缺** |

## 3. S0 缺口清单（按门槛四格归并）

1. **体积/RSS/冷启动：七方向无一份完整记录**（唯一实测=laz-perf RSS；X_T 只有吞吐、3DM/RVT 只有工件体积、JT/Tiles/SW 无）。
2. **失败分类：3D Tiles、SolidWorks 全缺**；点云缺格式级损坏反例执行证据（语料已含反例）。
3. **依赖：3D Tiles 无可构建候选（离线）**；点云缺 XercesC 3.2.x 与 PDAL 完整源码包锁定（PLAN-02 §7.2 已列）。
4. **样本：SolidWorks 真实 SLDPRT/SLDASM 为 0**；3D Tiles 语料许可未声明；JT 版本矩阵（LOD/B-Rep/PMI/引用）与多学科 RVT/RFA 覆盖不足。

## 4. 建议补齐顺序（最小动作）

1. **复用 `build-trial/measure-run.ps1` 补 RSS/耗时**（成本最低）：对已构建产物逐个测——laz-perf readlaz（已有，复核）、openNURBS example_read（MSVC）、rvt-rs 源身份检查器、X_T cad-cli 109 件、jt-reader 转换链；一次跑齐四格中的 RSS 列。
2. **3D Tiles 解锁**：在线一次性安装 3d-tiles-renderer 依赖并 vendor 锁定（或私有 registry 快照），对 manifest 6 件 fixture 跑 tileset 遍历/b3dm 解析回归 + 截断反例；同步解决 222 件语料许可（换授权语料或取证）。
3. **点云失败分类**：用已锁定 E57/LAS 正反例语料对 laz-perf/libE57Format 跑损坏块/缺 CRS/多站回归，留 `test-output/` 证据；补 XercesC 3.2.x、PDAL 源码包进依赖锁定。
4. **SolidWorks 起步**：按工作区硬门槛先查 `D:/Download` 与公开来源登记真实 SLDPRT/SLDASM；cadmpeg `cargo fetch` 后离线构建再谈容器级失败分类。
5. JT 补版本矩阵样本登记；RVT 按 inspect 口径推进流级版本解析，不越过 blocked 边界。

## 5. 诚实边界

- 本报告为文档盘点：未重新执行任何构建/测量；第 4 节动作均为待执行项。
- X_T 109 件"全通过"为研究/preview 证据，生产认证 profile 数为 0；RVT/SolidWorks 维持 inspect/blocked，不计几何完成。
- PLAN-02「本机无 MSVC」结论已被 [3dm-source-audit](./industrial-3dm-source-audit-2026-09-17.md)（VS2022 17.14 可用）推翻，引用时以后者为准。
