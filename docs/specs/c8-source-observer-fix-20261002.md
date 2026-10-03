# C8 source-vertex 观察器修正与 salvage 认证(2026-10-02)

Owner:[c8-full-chain-closure-audit-20261001.md](c8-full-chain-closure-audit-20261001.md);背景:[glm-handoff-20261001.md](../handoffs/glm-handoff-20261001.md)「C8」节。本文件是 2026-10-02 凌晨崩溃恢复(第 2 次)后的增量收口报告。原门不变:Three r185 默认参考、曝光、HDR `.002` / byte `2`;未降门、未挑点、未放宽。

## 1. v4 观察器修正(已实跑验证)

v3 失败链路已实证(非猜测):观察期对 flagged(deleted 但仍 attach)shader 调 `getTranslatedShaderSource` 返回 null 并入队 GL_INVALID_OPERATION(1282),被原 shared draw 门 `gl.getError()` 读到,误判为原 Three 绘制失败。preflight 证据:`test-output/c8-input-chain-20261001/jc-i-20261002-observer-gl-preflight.json`。

v4 修正四条语义,逐条与本轮实跑数据核对通过(`SourceProbe.ts` / `source-runner.mjs`):

1. **删除前收集 translated**:`installTranslatedCapture` 包装 `WebGL2RenderingContext.prototype.deleteShader`(及 WebGL1 防御性),在委托原 deleteShader **之前**用 `isShader` 守卫 + `WEBGL_debug_shaders` 捕获 ANGLE translated 源,WeakMap 去重,try/catch 不入渲染路径,finally 还原原型。
2. **观察期零危险调用**:观察期只做 `isShader` + `getShaderSource`(preflight 实证无错);不再调用 `getTranslatedShaderSource`/`getExtension`。
3. **不吞原 draw error、门独立判定**:观察器全程不触 `gl.getError`,原 shared draw 门读到的任何 GL error 只能来自原 Three 绘制本身。
4. **不可用即明示**:状态字段 `not-captured | captured-null | captured(NB)`,不推定 ISA,不让整轮失败。

v4 首跑(00:18)另有 slot 解码修正(修在候选线自有 runner,非放宽门):`tangent.w` 为透视插值 varying,常量透视插值允许 ~1 ULP(实测最大 `5.000000476837158`,全部 61440 像素聚成 6 簇 {0..5},`jc-i-20261002-slot-debug.mjs`);解码从精确整数改为 `Math.round` 后要求 `|raw-round|<0.01` 且 `0<=slot<6`,容差比半簇间距小 4 个数量级,歧义判定能力保留。WGSL 未动(加 flat 会改共享 location5 插值语义=动生产 ABI,禁止)。

## 2. 冻结状态(当前)

| 件 | SHA-256 |
|---|---|
| `source-runner.mjs` | `8026a98309f32cc334995fb5115d3983652545f5cc19590d2ca60413ec8f100b` |
| `source-bundle.mjs` | `ba08c82095644df92ad63aaf1a4514f411cb84c751de978818905a3b6070cf5c` |
| `source-freeze.json` | `a6c3dd63ef91b5d0106a9efa3d45ad82785deda3167f537a93b90fd875d51ae1` |
| 原基准 `c8-current-canonical-20261001/gpu-output/rounds.json` | `d92af27f25ce4b63dfbedb6a950942a0df14a9c42752273519f2df0cffd8e608`(未动) |

555 消费源完整性:runner 起止两次 `frozen()` 全过(run6)。bundle 自 run1(00:18)起未变——run1 failure 文件已记录同一 bundleHash;00:57 的重建只是把 00:56 的 runner 改动重新入冻。

## 3. run1–run6 时间线与 salvage 认证

| 时间 | 事件 |
|---|---|
| 00:18 | run1:v4 bundle 首跑,runner 侧旧精确整数 slot 断言失败(`failure-1790871507254.json`,preservation 全 0) |
| 00:30 | run2:ENOSPC 磁盘满(空 failure 文件) |
| 00:37 | run3:JS heap OOM |
| 00:38–00:52 | **run4:完成两轮(full+raw-normal)全部捕获并写 rounds.json + round-0/1.png,进程在最终断言/证据写出前被外部杀死(无 failure-*.json、无 evidence.json → 非 JS 异常)** |
| 00:52 | salvage:`rounds.json` → `jc-i-20261002-run4-salvage-rounds.json`(mtime 保留) |
| 00:56 | runner 改动 → run5 冻结漂移失败(即时失败,未消耗 GPU) |
| 00:57 | 重新冻结(runner 新 SHA 入冻,bundle 不变) |
| 00:59 | **run6:全断言通过完成**(passed/stable=true,actualRenders=36) |

**Salvage 关键事实:`jc-i-20261002-run4-salvage-rounds.json` 与 run6 `rounds.json` 字节级一致**(sha256 `d8224f6f…b3749a3`),四张 PNG 哈希亦全同。

salvage 认证(`salvage-analysis.mjs` → `salvage-analysis.json`,按当前冻结判据对 salvage 数据离线重跑全套断言):

- 结构:2 轮 × {full, raw-normal} × 4 帧齐全;每 capture 收据 passCount=5、drawCount=10、source.draws=10、uniformBytes=1040、matrixPublications=5、validationWitness=1,run.errors=[]。
- 守卫:原 Three 全数组 three32/threeDisplay max=0(16/16);strict-emissive deep HDR/display max=0;29968 稳定 mask 每帧重建(direct-diagnostic 15987/13981 断言过),全程稳定点合计 239744,GPU source row slot 解码全部落 {0..5} 无歧义。
- 跨轮稳定:剥离观察器 ANGLE translated 诊断字段后两轮逐字节相等(runner 注明该剥离的依据与证据指针)。
- raw-normal 与 full 的 `run` 逐字节相等(两轮)。
- 基准不可变:canonical 基准哈希与 run6 evidence 一致。
- **观察器 v4 生效证据:translated 状态 96/96 全部 `captured(NB)`**(真实 ANGLE HLSL,如 4053B/22547B/36211B 等),零 `not-captured`/`captured-null`。

**fresh 口径(如实)**:run6 = 当前冻结下完成的完整两 fresh,主证据;run4 两轮 = 独立进程、同一冻结 bundle 的 salvage 抢救轮,字节等同 run6,计为有效 fresh(salvage 口径,最终断言由本会话离线复验)。即两个独立进程共 4 个完成轮,两两字节一致(同进程跨轮剥离诊断字段后一致;跨进程含诊断字段也一致)。

## 4. 质量门判定:仍红(qualityCertified=false)

run6/salvage 的 full join(当前 Deep 实际 RGBA16F vs 未变原 Three 独立捕获 RGBA16F,`compareSharedScene`):

| 帧 | hdrMax | byteMax | 门(.002/2) |
|---|---|---|---|
| strict-emissive/front | 0 | 0 | 过 |
| strict-emissive/oblique | 0 | 0 | 过 |
| direct-diagnostic/front | 0.001953125 | 1 | 过 |
| direct-diagnostic/oblique | **0.0078125** | 1 | **hdr 超** |

8 超门通道(shared-rgba16f 实际存储路径,原门独立核查口径)未变:

- 近斜:`(76,45)` R/G/B 各 `0.00390625`;`(76,46)` R/B 各 `0.0078125`、G `0.00390625`
- 远斜:`(198,64)` R/G 各 `0.00244140625`

归因状态:source-vertex 候选是 CPU 输入链(MV/NM/projection 发布与原 Three clip 次序)的诊断观察件,不改变存储 half 舍入,也不承诺收敛该 8 通道;LD-15 在 `j3DFullLayerMatrix` 中为 diagnostic、无 HDR 阈值豁免,远斜 `(198,64)`(roughness .9/metalness1,邻域 11正/0负/7零)已被 owner 审计明确排除出 LD-15 高光峰豁免。故「8 超门通道归零或归因已登记 LD」均不成立 → **质量门未过**。按任务约定,正式双端方案不提升,待 root 裁定的前提(质量真过)未满足;如实登记:近斜最大 `0.0078125`、远斜最大 `0.00244140625`。raw FP32 控制差异另存(非量化误差部分),维持 owner 审计原文口径。

## 5. 本轮登记与不变量

- run6:36 opaque/HDR render + 16 Three display 登记(evidence `actualRenders:36`);29968 原 mask 与原 Three 全数组 0 守卫逐帧保留。
- 未 commit/push/reset/clean/stash;四项用户资产未触;未跑 cargo;基准文件只读且哈希校验不变。
- 诚实条款:本轮无 GPU 补跑(run6 已满足两模式×两 fresh,补跑属重复建设);run2/run3 失因为磁盘满/内存,属环境性、已被 run6 取代,不计入质量证据;salvage 轮次按上述口径计入,未伪报为常规 fresh。

## 6. 证据清单

- salvage 认证:`test-output/c8-input-chain-20261001/salvage-analysis.json`(生成器 `salvage-analysis.mjs`)
- run6 完成证据:`test-output/c8-input-chain-20261001/source-gpu-output/{evidence.json,rounds.json,round-0.png,round-1.png}`;日志 `jc-i-20261002-source-gpu-run6.log`
- run4 salvage:`jc-i-20261002-run4-salvage-rounds.json` + `jc-i-20261002-run4-salvage-round-{0,1}.png`
- 失败链归档:`failure-1790871507254.json`(run1 slot)、run2 ENOSPC / run3 OOM 日志、`source-v1-input-limit/`、`source-v2-program-guard/`、`source-v3-glerror/`
- 观察器 preflight:`jc-i-20261002-observer-gl-preflight.json`;slot 根因:`jc-i-20261002-slot-debug.mjs`;修正案:`jc-i-20261002-source-amendment-v4.md`
- 原门独立核查:`test-output/i-c8-original-gate-audit-20261001.json`;原 8 通道数值:`test-output/c8-current-canonical-20261001/analysis.json`

## 7. 下一步(沿 owner 审计,未闭项)

1. C8 主线仍开放:8 超门通道收敛或登记新归因证据(需 root 裁定接受的新口径,不得由本线自行放宽)。
2. source-vertex 候选线诊断产出已可用(compiled 三源 + translated HLSL 全捕获、GPU model-row 映射 6 slot 全观测),后续分析可直接消费 `rounds.json`/`salvage-analysis.json`,无需重跑。
3. `jc-i-continuation` 按约未改;本线状态以本文件与 `jc-i-20261002-round-done.json` 为准。
