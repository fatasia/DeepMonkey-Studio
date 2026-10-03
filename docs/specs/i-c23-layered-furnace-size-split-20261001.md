# I-C23 分层白炉测试职责拆分（2026-10-01）

## 现状核查

1. 源码/未跟踪检查确认唯一白炉 GPU 文件 `renderer/white_furnace_gpu_tests.rs` 已由本轮独立父响应 oracle 增长到 819 行；当前新增/untracked 是已知并行专线及四个受保护项，本刀不触碰。全源关键词查到分层段集中在尾部，旧球/墙位于此前。
2. Native `contract/types.rs`、TS `renderPacketTypes.ts` 与 `shader/materialLayeredSurface.ts` 已有 layered 数据、overlay 响应合同；本刀不改合同。共享父 fixture/render/readback 仍私有；子模块可读祖先私有成员，不扩大生产 API。
3. Cargo.toml 已固定 wgpu/winit/serde_json/pollster/bytemuck；拆分零依赖新增。通用 800 行门与引擎新叶 300 行门都需遵守。
4. `rt_pixel_gpu_tests.rs` 已挂载白炉；脚本未发现硬编码该分层 test 完整路径。仍在父模块保留原同名 test/ignore 包装，完整入口和短 filter 均不变。
5. `test-output/jc-i-20261001-layered-furnace-round1.log` 已有真实 65536 点父响应 oracle、0.0583% 峰误差与零覆盖逐位恒等证据；同规格记录两 fresh 与旧球/墙回归通过。已有数值能力不重建，拆分只验证结构/原函数体迁移。
6. 已读 handoff/remaining/恢复台账、`i-c23-native-layered-consumption-20261001.md` 与 `i-c23-layered-furnace-attribution-20261001.md`；真实缺口为本轮新增导致体量越门，不能改变 2%/8% 容差或改写既有白球/白墙。

**已有（不重建）**：父响应 oracle、分层 GPU 装配/回读/零覆盖合同、球/墙 fixture、已验同名入口。

**真实缺口**：819 行旧文件越通用 800 门；新拆模块须≤300，保持 GPU 条件/私有 fixture 共享与具名 test。

## 拆分边界

- `white_furnace_gpu_tests.rs` 保留旧球/墙与共享渲染 fixture；尾部为原同名 test/ignore 包装。
- `white_furnace_layered_gpu_tests.rs` 为其子模块，承接分层设备/墙装配与原 runner，访问父 private fixture；仅 runner `pub(super)` 供原入口调用。
- `white_furnace_layered_response.rs` 为分层子模块的辅助，承接原 oracle/数值断言；两函数 `pub(super)`，不改变函数体或容差。

## 验证与真实遗留

拆后父文件 **498 行**，新增 GPU 模块 **230 行**、response 模块 **111 行**，新叶均≤300。`test-output/i-c23-layered-size-split-20261001/migration-check.json` 的 5 项迁移比较全部 true：旧 sphere/wall/render fixture，分层 device/packet，oracle/阈值，runner，原 test/ignore 属性均原样保留（仅归一换行/新增 `pub(super)` 可见性）。原完整具名入口不变。

`node packages/deep-engine/scripts/sourceSizeGate.mjs`：files=2909、warnings=175、**failures=0**；通用 800 门仍因其他文件失败，白炉文件不再列入失败。限定 rustfmt/diff-check 通过。本专线没有运行 GPU/Cargo；主线集中重编及两 fresh 重跑，WASM source fingerprint 按真实源变化更新，不绕过 guard。

冻结 SHA-256：父文件 `3f046a0e5503e06b1cbb9f633cad7bf83a1d8b1dc1b5283951aef8ed109ae91a`；layered GPU `e867093425084db6bc4bdcdb8c979c81ff5c6e54fbf1e5fb5e43fa92243b8df8`；response `12ea210027cde648fda6d2fc551ed46ef0fc428d3a2081607d428dbeb15c8a4b`。

主线随后报告拆分重编及两 fresh 白炉 GPU 通过；重编暴露父文件未再使用 `FURNACE_TOLERANCES`，等待 WASM 构建结束后删除该 import 并 rustfmt。父文件最终冻结 SHA256 为 `5fe779f9414f2a72b8b672ffd8bb217efd913d7f104038541ba74f0f32ae95b2`；该 import 清理后的最终构建由主线统一执行。
