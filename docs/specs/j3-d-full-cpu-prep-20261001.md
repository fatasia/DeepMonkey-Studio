# J3-D-full CPU 侧准备:逐层双端对拍矩阵与合法差异矩阵 v1

日期:2026-10-01。对应估时表 `J3-D-full`(HDR、阴影/法线与后处理逐层双端实渲对拍;扩展合法差异矩阵,8–16h)。
**本刀只做 CPU 可独立验证部分;任何 GPU/Cargo 实际执行由主线程统一串行**(命令清单见文末)。

## 现状核查(六步)

| 六步 | 已有(不重建) | 真实缺口(本刀补 CPU 侧) |
|---|---|---|
| 1. 全仓 grep | `j3-gate-d` 相关实现已定位:Native `tests/support/j3_geometry_depth.rs`、`j3_normal_attachments.rs`、`j3_shadow_visibility.rs`、`j3_texture_coverage.rs`、`j3_output_dump.rs`、`j3_author_fog.rs`;runner `scripts/j3-{geometry-depth,normal-shadow,shadow-visibility,bloom-texture,fog-profile,display,author-fog,web-author-fog-modes,texture-coverage}-parity.mjs`;比较器 `scripts/lib/j3{HdrFlat,GeometryDepth,ShadowVisibilityIntervals,BloomTexture,FogProfile,Display,NormalShadow,TextureCoverage}Parity.mjs` 全部在用。 | 各层 gate 独立验收,没有"层×双端×场景格"统一目录与聚合 evidence;合法差异散落在各规格正文,没有机器可读矩阵。 |
| 2. 契约/规格 | J3 gate-D 规格五份已读(geometry-depth / hdr-normal / normal-shadow / shadow-hdr-visibility / texture-coverage / output-first-cut);J2-B6 Bloom/Fog 矩阵规格已读;`test-output/interrupted-0930/` 各层 evidence 均在。 | 无逐层清单与"每层适用门"结论文档;无新发现差异的登记格式。 |
| 3. 依赖 | 既有 Bloom CPU 参考 `lab/j3BloomTextureReference.ts`(web/native 双侧逐 half-store)、Fog CPU 参考 `lab/j3FogProfileReference.ts`(web=volumetricFogPassCpu 镜像,native=frame 依赖 oracle)、display 阈值 `fixtures/display-parity-v1.json`、half 编解码 `lab/temporalAaProbe.ts`。 | 不新增依赖。 |
| 4. 消费方 | 双端 HDR 附件:Web `PBR_HDR_FORMAT rgba16float`/`PBR_DEPTH_FORMAT depth32float`/1x(`renderTargets.ts`),Native `FORWARD_COLOR_FORMAT Rgba16Float`+`Depth24Plus`+4x MSAA(`mesh_abi.rs`,`forward_targets.rs` 的 `with_normal_capture` opt-in 法线)。Web 后处理链 `pbrPostProcessChain.ts`(HiZ/AO/SSR/体积雾/TAA/上采样/Bloom/作者Bloom),Native `BloomPass`/`OutputPass`。并行线冻结文件未触碰。 | 双端逐层输出能力已够,无生产代码改动需求;本刀零生产文件修改。 |
| 5. 测试/证据 | geometry-depth evidence currentRun=true(axis 320/oblique 258 稳定内部像素、VP 误差≤9.5e-7、深度均值≤1.19e-7);hdr-flat-normal currentRun=true(12对24腿 strict 全零差);shadow-visibility evidence currentRun=true(170 样本区间零差,含 `normals` 同批法线结果);bloom-texture/fog-profiles/display-parity 为历史分段 receipt(currentRun=false);J5 `GATE_PAIRS` 16 对 32 腿已含其中七对。 | 缺统一聚合入口(聚合时逐层拦截错层/错门/过期)。 |
| 6. 规格 | 本文档;恢复台账与 handoff 已对齐,不与并行线(C8/J3纹理/B5/I-C19/I-C23/N10)抢文件。 | — |

**结论:八个层全部已有独立验收 runner 与 evidence,本刀不重建任何一层的 GPU 门;真实缺口是"逐层目录+口径结论+合法差异矩阵+聚合骨架",全部可 CPU 独立完成。**

## 逐层清单与每层比较口径

场景格身份全部来自冻结 fixture/manifest(GPU 前登记,不在 GPU 后选格):几何/HDR/法线/阴影层=axis+oblique 两相机;Bloom=6 案例;Fog=8 共同 profile+2 Native 独有;Display=8 冻结色块。

| 层 | 附件(Web / Native) | 门(唯一绑定) | .002 HDR 门 | display 字节门 |
|---|---|---|---|---|
| geometry-coverage | depth32float 1x 覆盖 / Depth24Plus 4xMSAA 逐样本覆盖 | geometry-depth-interior:VP≤2e-5;全覆盖内部 1px 轮廓 | 否 | 否 |
| main-depth | depth32float 中心样本 / retain_depth 4 样本均值 | 同上:内部均值≤2e-6;边界 1px | 否 | 否 |
| normal | viewNormal rgba8unorm 转换 world / opt-in worldNormal+roughness | normal-quantized-angle:UNORM8 单端量化角界 0.38917633°,双端 +.01° | 否 | 否 |
| shadow-visibility | 生产 HDR/control 比值,uniform 39vec4 / 21vec4 | shadow-half-interval:binary16 中点区间+单次 f32 乘 2^-23 预算,双端区间必须相交 | 否 | 否 |
| hdr-color | rgba16float / Rgba16Float resolved | hdr-flat-strict:同 uniform 同材质同光冻结 mask,最大通道差≤0.002、PSNR≥60、SSIM≥0.9999、CPU Lambert 下界 | **是(唯一适用层)** | 否 |
| post-bloom | BloomPass 5 级线性 HDR / 半分辨率 blur+OutputPass 显示域 | post-half-store:各宿主对独立 CPU 参考 `abs≤.003+|ref|*.004`;跨宿主等值不是门 | 否 | 仅诊断差异记录 |
| post-fog | march/scatter+composite 线性 HDR / OutputPass exp/volume | post-half-store 同上 | 否 | 仅诊断差异记录 |
| display | pbrOutputShader RGBA8 / OutputPass RGBA8 | display-byte:≤1/255、SSIM≥0.999;WGSL/GLSL 库≤2e-5 | 否 | **是(唯一适用层)** |

**口径结论(.002 与字节门的层内适用性)**:`1/255 = 0.00392 > 0.002`。display 字节门是 8bit 显示域的量化下限,若用于 HDR 层即放宽既有 0.002 严格门(放水,禁止);0.002 门用于显示域则必然假失败(过严)。两门全局互斥、各只适配一层。Bloom/Fog 两层因"各宿主合法 profile 不同"不存在跨宿主等值门,只能逐宿主对含幅度项的 half-store 门;跨宿主差异只记诊断。阴影层因可见度由 HDR 比值推导,真值本身是 half 区间,用区间相交而非点值门。

## 合法差异矩阵 v1(全文)

机器可读真源:`scripts/lib/j3DFullLayerMatrix.mjs` 的 `LEGAL_DIFFERENCE_MATRIX_V1`。status:confirmed=已有实测证据;diagnostic=只诊断不设等值门。

| id | 层 | 差异 | 允许域(rule) | 证据 | status |
|---|---|---|---|---|---|
| LD-01 | geometry-coverage, main-depth, hdr-color | Native 4xMSAA vs Web 1x 主目标采样 | 轮廓/棱线仅 1px;内部稳定域严格 | geometry-depth 规格、renderTargets.ts、mesh_abi.rs | confirmed |
| LD-02 | main-depth | Depth24Plus 4xMSAA 逐样本 vs depth32float 中心样本 | 只在双方全覆盖内部稳定像素比较 | geometry-depth 规格 | confirmed |
| LD-03 | hdr-color | Web deepGeometryRoughness 导数粗糙度项+下限 0.06 vs Native 无该项+下限 0.045 | 平法线 mask 严格 0.002;smooth cube 仅诊断,禁拟合容差 | hdr-normal 规格 | confirmed |
| LD-04 | hdr-color, display | DFG:Web three@0.185 LUT(16x16 RG16F 双线性)vs Native 解析/常量 DFG | 记诊断;严格门只在无 IBL/常量 DFG 路径认证 | directDfgLut185.ts、c8-native-dfg-correlated 规格 | diagnostic |
| LD-05 | post-bloom | Bloom 合法算法/默认档不同(Web box5级 vs Native 半分辨率±0.25/radius1) | 各宿主对独立 CPU 参考 half-store 门;跨算法等值不是门 | j2-b6-bloom-texture-matrix 规格、j3-bloom-texture-v1.json | confirmed |
| LD-06 | post-fog | Fog 合法域不同(Native exponential/steps1/无作者linear;Web HG 含 1/(4π) 等) | 按各自公式全像素 half-store 门;模式差异登记 | j2-b6-fog-profile-matrix 规格、j3-fog-profiles-v1.json | confirmed |
| LD-07 | shadow-visibility | CSM 级联合同 2..4/21vec4 vs 1/39vec4;depth-fit 矩阵各自独立 | 共同严格矩阵仅 4 级联;区间相交判据;各自原始 uniform 保存 | shadow-hdr-visibility 规格 | confirmed |
| LD-08 | normal | 法线域与格式:Web 视图域 rgba8unorm vs Native 世界域 opt-in capture | 经正式相机基转换到 world 后比较;量化角界门 | normal-shadow 规格 | confirmed |
| LD-09 | hdr-color | 默认宿主光照不同(Web 默认 ray 灯+次灯 vs Native legacy 太阳+IBL) | HDR 对拍必须走共同 authored-single-sun 档;默认档只作诊断 | hdr-normal 规格 | confirmed |
| LD-10 | display | 非中性分级/曝光档两端各有扩展;共同档=曝光1+Narkowicz ACES+无分级 | 共同档字节门;非中性档由 C8 库另验(≤2e-5) | output-first-cut 规格 | confirmed |
| LD-11 | hdr-color, post-bloom, post-fog, shadow-visibility | 同为 rgba16float 但受 binary16 量化台阶 | 阈值两侧必须用 half 区间/含幅度项门;禁拟合常量 epsilon | ShadowVisibilityIntervals、BloomTextureReference | confirmed |
| LD-12 | hdr-color, geometry-coverage | 背景 clear 语义(Native 默认线性 [0.012,0.020,0.035],Web 取同值) | 背景不在材质对拍域;角点须读出 clear=1 | texture-coverage 规格 | confirmed |
| LD-13 | shadow-visibility, hdr-color | MSAA 观察接缝(Native 观察=encode_opaque_pass(retain_depth) 非 discard 快路径) | 默认生产路径不变;角点远平面 clear 前置判据 | geometry-depth 规格 | confirmed |
| LD-14 | display, hdr-color | 采样/透明语义:Web 单样本+Weighted OIT vs Native 4xMSAA+排序 alpha | 共同透明语义仅限单非重叠层;OIT 一致性不在 J3-D-full | texture-coverage 规格 | diagnostic |

**新发现差异登记格式**(经 `registerLegalDifference` 校验后追加):`{ id:"LD-xx"(唯一), layer:[已知层id], difference, host:{web,native}, rule(允许域), evidence:[仓内文件路径,必须存在], status:"confirmed"|"diagnostic" }`。缺字段/撞号/未知层/证据文件不存在均拒绝。

## 交付文件(CPU 侧)

- `packages/deep-engine/lab/j3DFullLayerMatrix.ts`(235 行):层/门目录(唯一真源)、场景格展开、`.002`/字节门互斥不变量、后处理期望生成器(复用 j3BloomTextureReference/j3FogProfileReference,**不重写算法**;Fog native 期望诚实标注 frame 依赖)。
- `packages/deep-engine/lab/j3DFullLayerMatrix.test.ts`(7 测试):目录完整性、门互斥、evidence 目录存在性、格数、期望确定性。
- `scripts/lib/j3DFullLayerMatrix.mjs`(166 行):合法差异矩阵 v1、登记格式校验、层 evidence 合同校验(错层/错门/过期/失败/不稳定/历史冒充 fresh 全部 FAIL)、聚合 evidence 结构。
- `scripts/lib/j3DFullLayerMatrix.test.mjs`(8 测试):上述负例全覆盖 + 聚合器合同。
- `scripts/j3-d-full-layer-matrix.mjs`(93 行,esbuild 载入 lab 目录避免双份真源):默认=计划模式(格网+GPU 命令,不执行 GPU);`--prepare`=逐层新鲜度核验,过期/不可读/身份不符即失效删除(对齐 j3-texture 模式);`--compare`=仅历史聚合,currentRun=false。

### 实测结果(本刀,全部 CPU)

- `node --test scripts/lib/j3DFullLayerMatrix.test.mjs`:8/8 PASS。
- `npx vitest run lab/j3DFullLayerMatrix.test.ts`(packages/deep-engine):7/7 PASS。
- `npx tsc -p tsconfig.lab.json --noEmit`:本刀新文件 0 错;余 12 错全部位于 `lab/iblPrefilterReference.ts`、`lab/iblReferenceEncode.ts`(与 HEAD 逐字节一致,属既有/其它线问题,不属本刀,未改动)。
- `node scripts/j3-d-full-layer-matrix.mjs`:计划 30 格(8 层)打印成功;`--prepare` 对现存 evidence 实测:geometry-coverage/main-depth/normal/shadow-visibility/hdr-color=fresh(统一回执),post-bloom/post-fog/display=historical-retained;`--compare` 聚合 30 格、currentRun=false、freshnessNotes 诚实标注 normal/shadow/display 三层 receipt 无 fixture 身份键(靠 currentRun/execution 语义)。plan.json/prepare-report.json/evidence.json 已落 `test-output/interrupted-0930/j3-d-full-layer-matrix/`。
- 法线层 canonical fresh 回执指向 `shadow-visibility/evidence.json`(统一 runner 同批写 `normals`);`normal-shadow/` 保留为历史首刀 receipt。

## 主线程 GPU 命令清单(顺序即建议执行序;root 串行;禁止 --compare/--web-only 替代 strict 腿)

```bash
node scripts/j3-geometry-depth-parity.mjs              # geometry-coverage + main-depth(双端 fresh)
node scripts/j3-geometry-depth-parity.mjs --hdr        # hdr-color(共同单灯 strict)
node scripts/j3-shadow-visibility-parity.mjs           # normal + shadow-visibility(统一 fresh,同批 normals)
node scripts/j3-bloom-texture-parity.mjs               # post-bloom(具名 Native + 两 fresh Web)
node scripts/j3-fog-profile-parity.mjs                 # post-fog
node scripts/j3-web-author-fog-modes.mjs               # post-fog 补充(Web-only 作者 linear/volume)
node scripts/j3-display-parity.mjs                     # display(双端同 runner)
node scripts/j3-d-full-layer-matrix.mjs --prepare && node scripts/j3-d-full-layer-matrix.mjs --compare   # 逐层新鲜度核验+聚合(非 GPU)
```

每条命令完成后由 `--prepare` 复核新鲜度,全部 fresh 后 `--compare` 产出 currentRun=false 的历史聚合;若需要"本次执行"语义的联合门,按 J5 `GATE_PAIRS` 既有对去重执行(`node scripts/j5-dual-end-gate.mjs --gpu-policy=auto`)。

## 未做与风险(诚实条款)

- **GPU 实渲对拍全部未执行**(铁律:主线程统一串行)。上表命令即剩余工作;若某层 runner 在当前 WIP 工作树上因并行线共享文件(pbrRenderer/pbrFramePlanExecutor/pbrOutputBindings/StudioDeepWebGpuBridge 等)失败,须等并行线收口后重跑,不得以历史 receipt 冒充 fresh(聚合器已拦截)。
- **合法差异矩阵 v1 是基线不是全集**:14 条全部来自已验收规格与源码;LD-04(LDG/常量 DFG)当前 status=diagnostic,`directDfgLut185.ts` 属并行线未跟踪文件,Web 端真正消费该表后的 HDR 层差异幅度需 GPU 实测后再定级(新差异按登记格式追加,不许静默放宽原门)。
- **纹理覆盖层(第 9 层)未纳入矩阵**:j3-texture-coverage CPU 侧已收口但 GPU 未跑,evidence 尚不存在;其 fixture(七派生包)稳定域已冻结,主线程 GPU 完成后可按 `REQUIRED_LAYER_GATES` 同族格式追加第 9 条目(建议 gate=text-coverage-strict,门沿用 texture-coverage 规格)。
- **三份历史 receipt 无 fixture 身份键**(normal/shadow/display):新鲜度只能靠 currentRun/execution 语义,聚合器已用 freshnessNotes 显式声明;补身份键需改各层 runner 落盘格式,属 GPU 批次一并做更合适,本刀不动既有 runner。
- **Bloom/Fog 期望生成器未验证 GPU 逐字节一致**——它只是既有已验收参考的引用与 digest 登记,不构成新的独立门;若未来参考实现变更,`--prepare` 的 fixtureHash 门会按设计失效旧证据。
