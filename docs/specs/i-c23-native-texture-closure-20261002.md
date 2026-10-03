# I-C23 Native 纹理验收收口报告（2026-10-02）

会话：I-C23 线路唯一 cargo 所有者（串行），崩溃恢复后从断点继续。未 commit/push/reset/clean/stash/checkout；四项用户资产未触碰；生产材质 ABI/数学未改（本片全部为 test-only 叶）。

## 1. 现状核查（恢复进度判定）

1. `git status`：`packages/deep-engine-native` 下 I23 相关测试叶与大量前会话修改并存；I23 五叶（fixture / gpu_tests / observer / store / 父文件模块声明）均已接线。
2. **bits amendment 已应用且 afterSHA 与 repo 实际文件逐位匹配**（`test-output/i-c23-locked-texture-bits-20261001/amendment.json` 记录 applied=2026-10-02、含守卫补强说明；实测 SHA256：）

| 文件 | afterSHA（amendment 记录） | 实测 SHA256 | 匹配 |
|---|---|---|---|
| `src/renderer/layered_texture_observer.rs` | `db95c0f62133e42d110c2025988eda5baee8e8cfa48995a1c167e0ae8a183f8f` | 同左 | ✓ |
| `src/renderer/layered_texture_gpu_tests.rs` | `b6e941b816721490d14f7efc1885d1a8fa60642f68f16a8f14fd2a97f08356e8` | 同左 | ✓ |

   bits 目录内 `layered_texture_observer.rs` 是**改动前的 staged 旧版**（测试名仍为 `half_residual_contract`），勿据此判断现状态；以 repo 内 SHA 为准。CPU 叶已按 amendment 改名为 `layered_texture_observer_keeps_original_arithmetic_and_exact_word_chunks`。
3. **崩溃残留判定**：`test-output/jc-i-20261002-i23-native-texture-round1.log`（前会话 00:40 最后写）在 part B 主测试的 parent1 观察段中途截断，该轮**无效，已整轮覆盖重跑**并在本报告注明。截断前可见三帧 bitcast 均已 `original_arithmetic_restored=true`，说明崩溃前二进制已含 amendment 代码，崩溃非测试断言失败（日志无 panic，属进程中断）。
4. 旧失败四份日志（`jc-i-20261001-i23-native-texture-{gpu-round1,diagnostic,precision-round1,capture-round1}.log`）**原样保留未覆盖**。
5. 已验事实未重做：Web 两 fresh 35 点、旧 G/B 白炉 65536 点 0.0583%、coat+metal 组合双端 24 帧（`jc-i-20261001-i23-native-combinations-root-verified.json`：24×65536、maxError 0.0005225038744440802 过 0.002 门、两 fresh HDR hash 逐帧一致）、public 作者 package 例。

**已有（不重建）**：上述全部双端证据、19 纹理 device、HDR 回读、bits 方案与守卫（前会话已补）。
**真实缺口（本轮）**：bits 方案无任何 CPU/真实 GPU 两 fresh 结果；ignored 主测试从未真正通过。

## 2. 观察器（本轮方向与守卫）

**为何 hi/lo pack/unpack 残差结构性无效**（不再假设残差有效）：真实着色器编译器把 `unpack2x16float(pack2x16float(x))` 折叠回 `x`——诊断帧发 `(color-half(color))*1024` 全 196608 值非零计数为 0，残差零信息，重建只能停在 half 格点，0.006718745947708271 复现。

**现行方案 = bitcast 整数 11/11/10 位三帧拼回 F32**（`observer_source`，接缝 `"vec4f(color, output_alpha)"` 必须=4 处实际 color 返回表达式）：

- 三个 shift（0/11/22）分别把 `bitcast<vec3u>(color) >> shift & mask`（mask 2047/2047/1023）当普通整数经真实 rgba16float 4x-MSAA store 路径输出；整数 ≤2047 在 binary16 精确表示，四样本均值精确还原；三帧按 `round()` 拼回原始 f32 word。bitcast 不可被折叠。
- 守卫（本轮逐条核实存在且生效）：
  - shift=22（指数/符号位）块必须严格整数（`fract()==0.0`）；
  - 尾数块允许落 binary16 网格点（4x resolve 均值为实现定义精度，实测 38+1 个 k/2 值），但必须是精确 binary16 网格点（`half_to_f32(f32_to_f16(v))==v`）；`inexact==0` 硬断言，违例即真实损坏；
  - 每帧 `nonzero>0`（观察器实际被消费）；
  - 换回原 seam 后整个 WGSL 逐字等同（`patched.replace(replacement, seam)==source`），四入口（`fragment_main`/`fragment_main_layered`/`fragment_normal_capture`/`fragment_normal_capture_layered`）均含 bitcast 且 capture 分支原表达式不动；
  - **实际消费 + 完整拼回证明**（`assert_reconstruction_restores_production_pixels`）：观察到的 prestore f32 经与渲染目标同一 binary16 转换再量化，必须复现 plain production 像素 ≤1 ULP——本轮 base/parent0/parent1/layered 四处实测 `worst_half_ulp=1`。
- oracle 链条：真实未量化父 response（base/parent0/parent1 各走观察器）→ 独立 CPU f64 凸混合（`expected`）→ 只含 `textureLoad`、不含 deepLayer/brdf 的独立 GPU RGBA16F store-only pass（`layered_texture_store.rs`）→ 与原 actual HDR16 全 65536 点对 0.002 原门；rawF32 0.002 门并行保留。

## 3. 逐命令逐结果（两 fresh，独立进程分日志）

编译前 `touch` 四个 I23 测试叶（防旧 mtime 跳编）；incremental 已清空故首轮编译 27.38s（deps 1607 文件保留未动），命中确认：part A 出现改名后 `exact_word_chunks` 测试（二进制含 amendment 代码），命中数 2 passed + 1 ignored > 0。

### fresh round1（`test-output/jc-i-20261002-i23-native-texture-round1.log`，覆盖崩溃残留）

- **part A** `cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --bin deep-engine-native layered_texture_ -- --nocapture --test-threads=1`
  → `test result: ok. 2 passed; 0 failed; 1 ignored; 0 measured; 420 filtered out`，exitA=0。通过叶：fixture 合同/编码、observer `exact_word_chunks`。
- **part B** `cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --bin deep-engine-native layered_texture_production_matches_independent_parents_and_uv_mr_controls -- --ignored --nocapture --test-threads=1`
  → `test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 422 filtered out`，exitB=0，37.82s。
  `layer_texture_precision raw_max_error=0.00061905771680415 original_hdr16_max_error=0.00048828125 parents_unquantized=true oracle_hardware_store=true observer=exact_f32_word_chunks`
  `layered_texture_executed=true pixels=65536 max_parent_error=0.00048828125 controls=[("untextured", 7.88330078125), ("wrong-uv", 7.5625), ("swapped-mr", 8.027099609375)] coverage0_identity=true alpha0_identity=true`
  `layer_texture_restore_guard base/parent0/parent1/layered worst_half_ulp=1`；`layer_texture_bad_pixels=0`。

### fresh round2（`test-output/jc-i-20261002-i23-native-texture-round2.log`，独立进程）

- part A：`test result: ok. 2 passed; 0 failed; 1 ignored; ... 420 filtered out`，exitA=0。
- part B：`test result: ok. 1 passed; ... 422 filtered out`，exitB=0，52.99s。
  **全部数值与 round1 逐位一致**（raw_max_error 0.00061905771680415、hdr16 0.00048828125、三负控 7.8833/7.5625/8.027099609375、65536 点）。

## 4. 原失败对照（四份保留日志）

| 日志 | 失败点 | 消息 |
|---|---|---|
| `gpu-round1`（10-01 23:00） | HDR16 0.002 门（旧 :91） | `original I23 texture parent response error 0.006718745947708271` —— oracle 用 half 读回父帧先量化 |
| `diagnostic`（10-01 23:06） | 单层归因 | replace/overlay 均失败、层1两模式通过，排除 overlay MSAA 协方差假设 |
| `precision-round1`（10-01 23:26） | rawF32 0.002 门（:151） | `original I23 unquantized response error 0.006718745947708271` —— hi/lo 残差被编译器折叠，raw 仍 half 格点 |
| `capture-round1`（10-01 23:31） | rawF32 0.002 门（:151） | 同上；capture 入口补观察后仍同值，证实残差机制本身无效 |

四者同根因：**无有效 F32 读回 → oracle 过早量化**。bits 方案取得真实未量化值后，raw 误差 0.00061905771680415、HDR16 误差 0.00048828125，均约为原门的 1/3 与 1/4（改善一个数量级），且未动门、未挑点、未放容差。

## 5. 原门是否原样

是。逐条核实 `layered_texture_gpu_tests.rs`（SHA `b6e941b8…`）：

- 原 actual HDR16 全 65536 点 0.002 门（`max_error <= 0.002`，`"original I23 texture parent response error"`）原样；
- rawF32 0.002 门（`raw_error <= 0.002`，`"original I23 unquantized response error"`）原样；
- 三负控（untextured / wrong-uv / swapped-mr，须 `difference > 0.001` 敏感）原样；
- coverage0、alpha0 逐值恒等（与 base 整帧 `assert_eq!`）原样；
- 全 65536 点逐点比较，无降门、无挑点、无新容差。

## 6. I-C23 行剩余盘点

已闭（本轮新增）：Native 空间按层 RGB+MR、独立 UV0/UV1、alpha/coverage、replace/overlay 的真帧父响应验收两 fresh（本行最后一块硬证据）。

行内已有且保留：双端白炉（Web 35 点两 fresh；Native G/B 65536 点 0.0583%）、coat+metal 组合双端 24 帧、完整组合 Native 24×65536 两 fresh（0.000522504）、正确 dΩ 5 层栈×4 视角 CPU 炉（1+1e-3 门）、public 作者 package 例实际 runtime-package 消费、304B/纹理生命周期。

**剩余缺口**：
1. **浏览器双端同场景对拍**（同一 fixture Web ↔ Native 像素级对照）——本轮按约束不跑（GPU 浏览器矩阵被另两路占用），列为缺口；现有是"双端各自过门"，非同场景直接对拍。
2. 原锁行外的后继（大型 Studio 层 UI、未来材质瓣 transmission/任意 dielectric aniso）按 owner 审计明确**不属本行**，不计入。
3. `remaining-tasks-estimates-20260930.md` I-C23 行状态由 root 按本报告更新（本会话未改该行）。

CPU/合同子项：本轮 part A 已含 fixture 合同/编码叶与 observer 算式叶，两 fresh 均过，无遗留红项。

## 7. 诚实条款

- 崩溃根因（00:40 进程中断）未定位（日志无 panic、无 OOM 记录），仅确认非测试断言失败；重跑两 fresh 稳定通过。
- bits 方案守卫中"尾数块允许 binary16 网格点"依赖 resolve 均值为实现定义精度这一实测事实；守卫把该自由度收窄到网格点并以 `inexact==0` 硬断言，但跨驱动/跨机型行为未做扫描（本机单 adapter 两 fresh）。
- 本机单 adapter；"两 fresh"指两次独立进程运行，非两块物理 GPU。
- 浏览器双端对拍未执行（见第 6 节），不得据此宣称双端像素级一致。
