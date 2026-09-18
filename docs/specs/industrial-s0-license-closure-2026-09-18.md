# 工业 S0 依赖许可闭包汇总

2026-09-18。汇总四组既有 inventory 证据与格式级源依赖的许可文件本体,给出逐依赖"名称/版本/许可证/分发义务/证据路径/SHA"一行结论。**本文件只汇总已存在的证据,不新增审计结论;这是 inventory 级闭包,不是已完成的法律来源审查。**

证据基线:

- worker(Rust):`test-output/industrial-worker-licenses-20260918/evidence.json`(250 crate,`--offline --locked`,crate 级上界,noassertion=0)
- glTF 管线(Node):`test-output/industrial-gltf-pipeline-licenses-20260918/evidence.json`(54 包,逐包逐文件 SHA)
- 3D Tiles(Node):`test-output/industrial-tiles-licenses-20260918/evidence.json` 与 `industrial-tiles-licenses-offline-20260918/evidence.json`(9 包,两次独立运行 lockSha 一致,missingNotices=0)
- SolidWorks:`test-output/industrial-solidworks/qualification-20260918/source-license-inventory.json`(87 包 430 文件逐文件 SHA/SPDX)与 `vendor-inventory.json`(vendor 146 crate 6,645 文件 95,544,545 B),叙述见 [SW S0](industrial-solidworks-s0-2026-09-18.md)
- E57 负例与构建件:`test-output/industrial-e57-negative-20260918/evidence.txt`

## 1. industrial-worker-host.exe 随附分发闭包(Rust,250 crate)

| 项 | 值 |
| --- | --- |
| 根工件 | deep-engine-native 0.1.0,`LicenseRef-Deep-Monkey-Community-1.0`(= 仓库根 `LICENSE`"Deep Monkey Community Source License 1.0 / DMCSL-1.0",8,951 B,SHA `5d9c10f0b03ae189…`) |
| 锁文件 | `packages/deep-engine-native/Cargo.lock` SHA-256 `e2805f0320623519…`(与 worker evidence `lockSha256`、`apps/api/dist/industrial-worker/manifest.json` inputs 三处一致) |
| 许可分布 | 128 `MIT OR Apache-2.0`;58 MIT;18 `Apache-2.0 OR MIT`;9 `Zlib OR Apache-2.0 OR MIT`;8 `MIT/Apache-2.0`;6 `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT`;5 Apache-2.0;3 `MIT OR Apache-2.0 OR Zlib`;2 Zlib;2 `BSD-3-Clause OR MIT OR Apache-2.0`;2 `Apache-2.0/MIT`;2 `BSD-2-Clause OR Apache-2.0 OR MIT`;1 ISC;1 `Unlicense OR MIT`;1 `Apache-2.0 AND MIT` |
| 需点名的表达式 | `r-efi 5.3.0` = `MIT OR Apache-2.0 OR LGPL-2.1-or-later`(取 MIT/Apache 分支即无 LGPL 义务);`self_cell 1.3.0` = `Apache-2.0 OR GPL-2.0-only`(取 Apache-2.0 分支即无 GPL 义务);`unicode-ident 1.0.24` = `(MIT OR Apache-2.0) AND Unicode-3.0`(Unicode-3.0 为宽松许可,随附其 LICENSE 即可) |
| 分发义务 | MIT/Apache/BSD/ISC/Zlib/0BSD/Unicode 类:随包保留版权与许可文本;无强制 copyleft;`windows-sys 0.61.2` 已被 ThirdPartyNotices 覆盖(evidence `noticesCheck.coveredByThirdPartyNotices=true`) |
| 证据路径/SHA | `test-output/industrial-worker-licenses-20260918/evidence.json`(crate 级,repository/licenseSource 逐 crate 可溯) |
| 缺口(如实) | crate 级闭包未逐文件;含 Linux/macOS/Android 目标 crate(Windows 分发实际不含,但闭包未按目标平台裁剪声明);notice 汇编文件(THIRD-PARTY-NOTICES)未产出 |

## 2. glTF 管线闭包(Node,54 包)

主要包一行表(完整逐文件 SHA 见 evidence.json;lockSha256 `b87d7bc038c3974e…` = 其 package-lock.json):

| 名称/版本 | 许可证 | 分发义务 | 证据/SHA |
| --- | --- | --- | --- |
| gltf-pipeline 4.3.1 | Apache-2.0 | 保留 LICENSE.md + NOTICE | 逐包 sha256 `24eb3783cee556ef…`,notices 1 |
| cesium 1.145.0 / @cesium/engine 26.3.0 / @cesium/widgets 16.2.0 | Apache-2.0 | 同上 | 逐包 SHA 在 evidence.json,notices 各 1 |
| @spz-loader/core 0.3.1 | Apache-2.0 | 同上 | notices 1 |
| draco3d 1.5.7 | Apache-2.0 | 同上 | **notices 0(缺 notice 文件)** |
| @cesium/wasm-splats 0.1.0-alpha.2 | Apache-2.0 | 同上 | **notices 0** |
| lerc 2.0.0 | Apache-2.0 | 同上 | **notices 0** |
| @zip.js/zip.js 2.15.0 | BSD-3-Clause | 保留许可声明,禁用作者名义背书 | notices 1 |
| dompurify 3.4.15 | (MPL-2.0 OR Apache-2.0) | 任选一支;Apache 分支义务最轻 | notices 2 |
| protobufjs 8.8.0 | BSD-3-Clause | 保留声明 | notices 2 |
| pako 3.0.2 | (MIT AND Zlib) | 同时满足 MIT 与 Zlib 声明 | notices 1 |
| bluebird 3.7.2 / meshoptimizer 1.2.0 / ktx-parse 1.1.0 / autolinker 4.1.5 等 MIT 组 | MIT | 保留声明 | notices 1 |
| earcut 3.0.2 / quickselect 3.0.0 / kdbush 4.1.0 等 ISC 组 | ISC | 保留声明 | notices 1 |
| tslib 2.8.1 | 0BSD | 无强制义务(保留声明为惯例) | notices 1 |
| industrial-gltf-pipeline-qualification 0.0.0(本地根) | **declaredLicense=null** | 本仓库自有包 | packageSha `60ebee57bef10212…` |

**缺口(如实,不补结论)**:missingNotices=6(`@cesium/wasm-splats`、`bitmap-sdf 1.0.4`(MIT)、`draco3d 1.5.7`、`lerc 2.0.0`、`mersenne-twister 1.1.0`(MIT)、本地根包);evidence `reviewStatus` 原文:"per-file exception review and redistribution notice assembly remain required"。optional peers 与渲染端集成未在本清单内。

## 3. 3D Tiles 闭包(Node,9 包)

lockSha256 `7aa977b3c872ce15…`,在线/离线两次清单一致,missingNotices=0:

| 名称/版本 | 许可证 | 分发义务 |
| --- | --- | --- |
| 3d-tiles-renderer 0.5.2 | Apache-2.0 | 保留 LICENSE + NOTICE |
| @mapbox/vector-tile 2.0.4 / pbf 4.0.1 | BSD-3-Clause | 保留声明 |
| @mapbox/point-geometry 1.1.0 | ISC | 保留声明 |
| @types/geojson 7946.0.16 / resolve-protobuf-schema 2.1.0 / protocol-buffers-schema 3.6.1 / fflate 0.8.2 | MIT | 保留声明 |
| pmtiles 4.4.1 | BSD-3-Clause | 保留声明 |

说明:CesiumGS Apache-2.0 的 CesiumJS 侧许可证据在第 2 节(cesium/@cesium/engine);本表是 Tiles 渲染路径(3d-tiles-renderer)实际闭包。缺口同第 2 节:notice 汇编未产出。

## 4. 格式级源依赖(extracted 固定源,许可文件本体在库)

| 依赖/版本 | 许可证 | 分发义务 | 许可文件路径与 SHA-256(前16)/字节 | 使用件 |
| --- | --- | --- | --- | --- |
| openNURBS v8.35.26251.13001 | openNURBS SDK 许可(Robert McNeel & Associates 版权声明,AS-IS,**非 OSI 开源许可证**;内含未修改 zlib 及其许可文本) | 随包保留 LICENSE 原文;**未经法律审查** | `data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001/LICENSE` `de437cd429817f50` 2,191 B | example_read.exe、3dm-source-audit.exe |
| libE57Format v3.4.0 | Boost Software License 1.0(BSL-1.0,宽松) | 保留许可声明 | `…/extracted/libE57Format-v3.4.0/LICENSE.md` `c9bff75738922193` 1,338 B | e57-reader.exe |
| Xerces-C 3.3.0 | Apache-2.0 | 保留 LICENSE + NOTICE,标注修改 | `…/extracted/xerces-c-3.3.0/LICENSE` `cfc7749b96f63bd3` 11,358 B;`NOTICE` `95e5cca2ff3d0801` 560 B | e57-reader.exe(libE57Format 依赖) |
| laz-perf 3.4.0 | Apache-2.0 | 同上 | `…/extracted/laz-perf-3.4.0/COPYING` `959f77033ba56a3b` 11,347 B | readlaz.exe |
| rvt-rs v0.1.2 | Apache-2.0 | 保留 LICENSE + NOTICE | `…/extracted/rvt-rs-v0.1.2/LICENSE` `695b2081d14e9247` 11,284 B;`NOTICE` `a912ca6f35c770a8` 3,632 B | rvt-source-identity.exe |
| parasolid-kit v0.2.0(X_T 研究链) | MIT(根);`LICENSES/Apache-2.0.txt` 为传递组件 | 保留声明;X_T 生产桥必须为原生 worker,此件仅为 S0 研究依赖 | `…/extracted/parasolid-kit-v0.2.0/LICENSE` `f6e2a77034e7fd3c` 1,083 B | X_T 研究链 |
| cadconvert(X_T/STEP CLI 研究件) | MIT(Copyright (c) 2026 omerbasavul) | 保留声明 | `data/external-assets/format-research/cadconvert/LICENSE` `f0c511237c1a5fee` 1,089 B | cadconvert.exe |
| rhino3dm v8.32.0 | MIT(Robert McNeel) | 保留声明 | `…/extracted/rhino3dm-v8.32.0/LICENSE` `f57a154acc534312` 1,083 B | **无(PLAN-02 §5.4 submodule 缺失跳过,未进任何工件)** |
| cadmpeg v0.6.0(SW) | 根 Apache-2.0;文档/规范 CC-BY-4.0 | 保留 LICENSE;文档如随包需保留 CC-BY-4.0 归属 | `…/extracted/cadmpeg-v0.6.0/LICENSE` `db7332814a00615b` 11,357 B;`LICENSE-docs` `9ba9550ad48438d0` 18,657 B | cadmpeg.exe(SHA `14de5287e42a2756…`,Cargo.lock SHA `7bd734e57968fe54…`) |
| JT 方向 | jt-reader 为本仓库 Node 包;其 Node 依赖闭包不在上列四组 evidence 内 | — | — | `packages/jt-reader/dist` |

**LAS/PDAL 说明(如实)**:任务口径中的 PDAL 未进入任何已测分发物;点云实读链为 laz-perf 3.4.0(Apache-2.0,上表)。E57 侧 libE57Format v3.4.0 + Xerces-C 3.3.0 已固定并出负例证据。PDAL/OCCT/WASM reader 属计划内、未进实测闭包,不得据此声明已闭包。

## 5. 通用缺口清单(汇总,不补审计不下的结论)

1. 全部证据为 inventory 级;**per-file 例外审查与 redistribution notice 汇编(THIRD-PARTY-NOTICES 汇总文件)均未完成**(gltf/tiles evidence `reviewStatus` 原文)。
2. glTF 管线 6 包缺 NOTICE 文件、根 qualification 包 `declaredLicense=null`(第 2 节)。
3. worker Rust 闭包为 crate 级上界且未按目标平台裁剪;`self_cell`/`r-efi` 的多表达式需在分发配置中**显式选定宽松分支**并留痕(第 1 节)。
4. openNURBS 非 OSI 许可证,其随包分发的法律审查未做(第 4 节)。
5. cadmpeg 部分拆分模块缺单文件 SPDX,分发时需核对继承关系与依赖嵌套 notice(源:[SW S0](industrial-solidworks-s0-2026-09-18.md) 原文"该清单是逐文件风险盘点,不是已完成法律来源审查")。
6. JT 方向 Node 依赖闭包、PDAL/OCCT/WASM 计划内依赖无 evidence.json,列为后续闭包对象。
7. 本仓库根 `LICENSE`(DMCSL-1.0)与第三方许可的合成分发条款(notices 汇编如何随包、品牌页如何展示)未定义。

## 6. 回填关系

- [阶段差额](industrial-stage-delta-2026-09-18.md) S0 行"依赖许可闭包分发审查"由本文件与上述四组 evidence.json 支撑;剩余缺口即第 5 节,不得表述为已完成。
- 体积/冷启动/无网静态证据另见 [安装体积与冷启动](industrial-s0-install-size-coldstart-2026-09-18.md)。
