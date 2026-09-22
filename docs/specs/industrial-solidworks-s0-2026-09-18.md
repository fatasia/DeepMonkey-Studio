# SolidWorks S0 样本与开源构建证据

已取得 5 份 MIT 真实 SLDPRT，共 3,032,108 字节；cadmpeg v0.6.0 离线构建、来源标签隔离和 13 例容器验收完成。能力保持 inspect，不计零件几何或装配完成。

本轮继承 `test-output/industrial-s0-rss-20260917/SUMMARY.md` 已有 JT、3DM、X_T、RVT、点云五方向的真实工件/样本/RSS/耗时记录，不重置 GLM 已完成项。SolidWorks 是新增的第六方向基础证据；3D Tiles 第七方向由并行主线补齐。方向基础证据覆盖与许可分发、完整几何、产品 ready 的验收分开计算。

## 固定样本

来源仓库 `N1-Conception/SolidWorks-SheetMetal-Designs`，commit `7dc050ee10a9137f7cd2b653f191174ddfa98cc7`。每个模型对应目录含 MIT `LICENSE.txt`；下载逐项核验 Git blob、字节数并记录 SHA-256、许可哈希、预期几何与用途。模型保存在 `data/external-assets/industrial-format-plan/samples/solidworks-sheetmetal-20260918/`，完整记录见其 `manifest.json`。

| 样本 | 字节数 | SHA-256 |
|---|---:|---|
| 带孔薄壁圆筒 | 459389 | `584c64c01f1ca38cdc263825e9dde69b63574bca9f3f51466d30c5b7d5cf4e07` |
| 钣金安装支架 | 202750 | `f6e650c0b0095c9bb970a14994f165995ddf53db356f714aff9fe4a361cf92ba` |
| 气流防护支架 | 782562 | `49282cec8e82a23a192753383a33305a38394c2ba287308b704bff145d510687` |
| 钣金阶梯 | 1314136 | `4e624b14566f685e6b7b3112a52f9af033691179d41266473486707059962f62` |
| 环箍支撑件 | 273271 | `16cf9b74260683cdabc2bf8ac30d22af22979e935e011ea833aa58fb04d7d53d` |

这批文件为 SolidWorks outer-container version 4 分块 raw-DEFLATE 容器，不是旧 CFB。外层版本来自字节 4–7 的 big-endian 值；实际 inspect 均读到 `sw_version=16000`、`sldprt:sw-version-12000-plus` 和 Parasolid schema `SCH_3401225_34101_13006`，不据版本数字推断应用年份。预期几何和 mm 单位来自上游说明，不是已测量的几何真值。

`scripts/fixtures/fetch-industrial-sw-samples.mjs` 已补 4 次有限网络重试；哈希、长度错误直接拒绝，不重试掩盖。已有本地文件必须重新通过固定 blob 验证才能复用。将 `globalThis.fetch` 替换为抛错函数后重新运行仍通过，证明当前 5 份样本可离线复核。

## 开源源码与分发检查

固定 `cadmpeg v0.6.0` 源包和 Cargo.lock；`cargo fetch --locked` 已完成。本轮选择最小 `sldprt` CLI feature，不引入生产商业依赖。

`scripts/fixtures/audit-industrial-sw-source.mjs` 使用 `cargo metadata --offline --locked` 生成 Windows 非 dev 依赖闭包：87 个包、430 个本地源文件，逐项保留 SHA-256、SPDX 标记、crate 许可和递归 LICENSE/COPYING/NOTICE。证据：`test-output/industrial-solidworks/qualification-20260918/source-license-inventory.json`。

根代码许可 Apache-2.0，文档/规范 CC-BY-4.0。依赖声明包括 MIT/Apache-2.0/0BSD/Zlib/Unicode-3.0 等组合。cadmpeg、sldprt 和 ir 的部分拆分模块缺少单文件 SPDX；根许可仍存在，分发时需核对这些文件继承关系及依赖嵌套 notice。该清单是逐文件风险盘点，不是已完成法律来源审查。

已通过 `cargo vendor --offline --locked --versioned-dirs --no-delete` 固定完整 workspace 的 146 个 registry crate，目录为 `data/external-assets/industrial-format-plan/dependencies/vendor/cadmpeg-v0.6.0`。`verify-industrial-sw-vendor.mjs` 逐项核对 6,645 文件 SHA-256（95,544,545 字节），再以显式 source replacement 执行离线 Cargo metadata，确认所有 registry manifest 均解析到 vendor。证据见 `vendor-inventory.json`。这是本地离线源包准备，不等于已接入产品安装包。

## 构建与工件

实际执行：

```text
cargo build -p cadmpeg --no-default-features --features sldprt --release --offline --locked -j 2
```

依赖编译已推进到 `cadmpeg-ir` 和 `cadmpeg-codec-sldprt`，写 LLVM bytecode 时返回 Windows OS error 112（磁盘空间不足）。当时 D 盘剩余 0 字节；没有缺失源码或 crate。已用显式 target 路径 `cargo clean --release` 清掉本次失败产物 912 个文件、351.1 MiB，可按上述命令重建。其他任务产物未删除。

随后使用明确的独立 target `C:/Users/rain/AppData/Local/Temp/bim-cadmpeg-20260918-target` 重编，不搬 D 盘缓存。`scripts/fixtures/build-industrial-sw-bounded.ps1` 每 10 秒记录目录字节数和 C 盘剩余量；目录到 1900 MiB 或 C 盘低于 8 GiB 就终止本轮构建树，保留日志。

第一次 C 盘构建成功耗时 556.6 秒，但上游 `build.rs` 从解压目录向上找到了本产品仓库的 Git revision，导致 generator 误写 `gf2e53a93df1b`。最终构建加入 `GIT_CEILING_DIRECTORIES`，在相同预算根下使用 `archive-isolated` 新子目录；构建脚本输出已确认 `CADMPEG_BUILD_GIT=unknown`，固定身份由上游 archive、Cargo.lock 和最终 EXE 的 SHA-256 负责。没有修改上游源码。尝试清旧 C target 时 Cargo 因缺少 CACHEDIR.TAG 拒绝，旧目录保留，没有绕过保护删除。

最终构建 exit 0，596.824 秒，Rust/Cargo 1.93.0；预算根采样最大 1,291,168,885 字节，未触发 1900 MiB 停止阈值。工件为 `C:/Users/rain/AppData/Local/Temp/bim-cadmpeg-20260918-target/archive-isolated/release/cadmpeg.exe`，35,836,928 字节，SHA-256 `14de5287e42a27569e0fab333a99522a455c92502fbfd62cde26d1d0e31d4568`。Cargo.lock SHA-256 `7bd734e57968fe5403524dc010b7aad15e41970e287783c33b774589508d7e02`。构建日志与监控副本为 `test-output/industrial-solidworks/qualification-20260918/build-evidence-final.json`。

构建后运行 `scripts/fixtures/qualify-industrial-sw.ps1`。runner 包括 5 个真实文件，另将截断头、截断半文件、坏 CFB 和错误签名分别送入自动识别与强制 SLDPRT 两个入口，共 13 例；记录退出码、stdout/stderr、输入/CLI/lock 哈希、fresh-process 时间与每 1 ms 采样的 Windows PeakWorkingSet64。它不会清空 OS 文件缓存，因此不称物理冷缓存测量。当前并行编译负载存在，数字仅是 smoke 观测，不是绝对性能放行。

最终 13 例复跑无超时，5 个真实文件均 inspect 成功；坏 CFB 的强制入口明确报告 `invalid CFB header identity or byte order`。半截文件仍可能返回 exit 0，但只有 12 个 CRC block、0 个尾目录、dialect residual 和 unverified warning；强制垃圾/截断头也可能 exit 0、0 entry。不能只用退出码做资格判断。

| 真实样本 | 容器 entries | fresh-process 时间 ms | 采样峰值工作集 bytes |
|---|---:|---:|---:|
| 圆筒 | 54 | 99.9785 | 5046272 |
| 安装支架 | 54 | 81.1355 | 5533696 |
| 防护支架 | 58 | 89.2592 | 9912320 |
| 阶梯 | 54 | 116.1977 | 15503360 |
| 环箍支撑件 | 53 | 89.7671 | 2232320 |

工作集是进程存活期间采样到的峰值，可能漏掉短进程结束前的峰值；不是严格 RSS 上界。冷进程并不等于冷磁盘缓存，尚未在全新断网 Windows VM 上复核安装依赖。

新增 `industrial-sw-inspect-profile.mjs` 按真实 v16000 framed profile、非空 entries、CRC block/尾目录、admitted dialect 和无 losses 分类；仅返回 `container-inspect-only`，永不认证几何。2 项单元测试覆盖残缺、未知版本、warning 和零退出码。`summarize-industrial-sw.mjs` 还拒绝错误的 generator 标签，初次伪 Git 标签已被实际拒绝。

上游将 SLDPRT 能力列为 L1；本轮 inspect 不计几何完整性、工程验证或产品 ready。最终 `qualification.json`、`summary.json` 已生成，13 个实际报告都通过本地资格断言，generator 为 `cadmpeg 0.6.0+gunknown`；5 个真实结果为 `container-inspect-only`，8 个坏输入为拒绝或恢复性扫描不合格。SLDASM、多版本兼容、拓扑/孔洞/材质/PMI/配置、产品 Worker 接入和安装包分发仍未验收。
