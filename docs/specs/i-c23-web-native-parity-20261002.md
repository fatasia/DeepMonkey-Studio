# I-C23 双端同场景像素级对拍收口报告(2026-10-02)

会话:I 线专线(重启,前一实例静默死亡无产出,本实例从现状核查重启)。未 commit/push/reset/clean/stash;四项用户资产未触碰;**生产源零改动**(全部工作为 `test-output/i-c23-web-native-parity-20261002/` 内 test-only 叶:probe.ts / observer-pbr-shader.ts / orchestrate.ts / runner.mjs / tsconfig.json;源冻结前后逐哈希一致由 runner 内建守卫保证)。禁 cargo 遵守(Native 侧零跑零改)。

## 1. 现状核查(已验底座 → 本轮真实缺口)

已验且未重做:Native bitcast 观察器两 fresh(`jc-i-20261002-i23-native-texture-round{1,2}.log`:rawF32 0.000619 / HDR16 0.000488 / 65536 点 / 三负控 7.8833 / 7.5625 / 8.0271 / restoreGuard worst_half_ulp=1);Web 35 点两 fresh、Native G/B 白炉 0.0583%、组合双端 24 帧(各自过门)。

**真实缺口**(I-C23 行报告第 6 节列明的最后一块):浏览器双端同场景像素级对拍——此前"双端各自过门",无同一 fixture 的直接对照。补齐方式受两条硬约束:
1. Native 全帧 65536 点像素**无 dump**(native 测试无 dump 代码,本轮禁 cargo 重跑)→ 跨端逐点可比集 = Native 日志记录的 **10 个锚点像素**(worst 前 10,含 pixel 0/1,actual/oracle/base/p0/p1 原值)+ 两端各自全帧 0.002 原门 + 聚合统计对照;
2. Web 读回通道(opaque-hdr rgba16float,PBR_MAIN_SAMPLE_COUNT=1)**支持全帧 65536 点读回**,故 Web 侧全帧原门完整执行,无降级。

## 2. fixture 对齐方式(同场景证明)

Web 端以生产 `PbrRenderer` 逐参数复刻 Native `layered_texture_fixture.rs` + `layered_texture_production_matches_independent_parents_and_uv_mr_controls`:

| 维度 | Native | Web 复刻 |
|---|---|---|
| 相机 | PlayerView{yaw 0.55, pitch 0, focal 2.05, near 0.1, far 100, distance 4, target 原点} | eye=[-4sin0.55, 0, 4cos0.55]、fov=2·atan(1/2.05)、同 near/far;**一致性数值证明**:native `frame_data_with_camera` 公式 vs web `lookAt·perspective` 四墙角 ndc 最大差 **9.53e-8**(门 1e-5) |
| 几何 | facing_wall_vertices(center=eye+2·forward、half 3、normal=-forward、uv0=[-1,-1,2,-1,2,2,-1,2]、uv1=[2,-1,-1,-1,-1,2,2,2]、indices [0,1,2,0,2,3]) | 逐 op fround 镜像,同 UV/indices |
| 材质 | base [0.35,0.45,0.6]/0.1/0.8 + 层0 replace 0.65([0.95,0.8,0.55]/0.8/0.65, bc texCoord1 offset[0.13,0.04] scale[0.75,0.8] rot 0.17, mr texCoord0 offset[0.04,0.13] scale[0.8,0.75] rot -0.12) + 层1 overlay 0.4([0.14,0.65,0.8]/0.45/0.9, bc texCoord0 offset[0.11,0.08] scale[0.85,0.7] rot -0.09, mr texCoord1 offset[0.08,0.11] scale[0.7,0.85] rot 0.13) | 逐字段同;parent 包 = 层 surface 全键平铺为普通材质(native fixture::parent 同义) |
| 纹理 | 4×2×2 nearest;sRGB color0(alpha128)/color1(alpha192)+ linear mr0/mr1,数据逐字节同 | 同 |
| 光照 | row13=[0.8,0.7,0.6,**2**](author 模式 sun=rgb)+ row11=-forward(surface_to_light,N·L=1)+ lightingOptions=[1,0,0,0](曝光 1/阴影短路) | directional{directionWorld=forward, color=[0.8,0.7,0.6], **intensity=1**(web radiance=rgb×w 对齐 native author=rgb), castShadow=false} |
| 环境 | uniform_furnace_environment(0.5) 全 mip 均匀(native `FURNACE_ENVIRONMENT_RADIANCE=0.5` 与 TS `WHITE_FURNACE_ENVIRONMENT_RADIANCE` 同源常量)+ IBL on、fog DISABLED、probe GI 0、background [0.012,0.020,0.035] | uniformFurnaceEquirect(0.5)+features.environment、fog:false、exposure 1、同 background |
| 分辨率 | 256×256,4x MSAA | 256×256,单采样(生产 PBR_MAIN_SAMPLE_COUNT=1) |

**oracle 链与 native 逐式同构**:bitcast 观察器(web 侧经 esbuild alias 在测试 bundle 内把 `pbrShader` 解析到 wrapper,替换 4 个 color 返回接缝 `vec4f(color, coverage(...))`,guard 与 native observer_source 一致:出现计数==2/处、换回原接缝逐字等同、组合后模块无裸接缝、块值 0..2047|1023 整数、nonzero>0)→ 未量化 base/parent0/parent1 → f64 凸混合(`first=base(1-w0)+p0·w0; overlay=w1·clamp(p1,0,1); result=first(1-overlay)+p1·overlay`)→ 只含 textureLoad 的 rgba16f store-only 独立 pass(`layered_texture_store.rs` web 镜像,显式 unfilterable-float 布局)→ 与原 actual HDR16 全 65536 点 0.002 原门比对;raw 门并行。

## 3. 逐命令逐结果(两 fresh,两个独立 Chromium 进程)

命令:`node test-output/i-c23-web-native-parity-20261002/runner.mjs`(fresh1/`--fresh1` 为单跑;正式为双 fresh;每次 `chromium.launch` 独立进程,非同进程新页面)。typecheck:`tsc -p tsconfig.json` exit=0(`typecheck.log`)。

| 门 | fresh1 | fresh2 | 门限 | 结论 |
|---|---|---|---|---|
| cameraMatch(ndc max) | 9.53e-8 | 9.53e-8 | ≤1e-5 | 同场景相机成立 |
| **layeredGate(原门:actual vs oracle 全 65536×3)** | **0.000244**(badPixels=0) | **0.000244**(0) | ≤0.002 | **过,未降门/未挑点/未放容差** |
| rawGate(未量化 actual vs f64 oracle) | 9.5367e-7 | 同左 | ≤0.002 | 过 |
| restoreGuard(观察值再量化 vs plain) | 全帧 worst_half_ulp=1,violations=0 ×4 帧 | 同左 | ≤1 ULP | 过(与 native 同值) |
| 负控 untextured / wrong-uv / swapped-mr | 7.88330078125 / 7.5625 / 8.02734375 | 同左 | >0.001 同向 | 过,前两者与 native **逐位同值**,第三者差 1 binary16 ULP |
| coverage0 / alpha0 全帧恒等 base | 字节+hash 双 True | 同左 | 恒等 | 过 |
| 重复正式 draw(layered×2) | hash 相等 | 同左 | 逐位 | 过 |
| **跨端锚点(10 个 Native 记录像素)** | **max 0.000488** | 同左 | ≤0.002 | **过(=1 binary16 ULP)** |
| validationError / session errors / dispose 后资源 | 零/零/0(plain+3 观察器) | 同左 | 全零 | 过 |
| 跨 fresh 全帧 hash(逐帧) | —— | 与 fresh1 **逐帧一致** | 逐位 | 过(两独立浏览器进程) |

源冻结:runner 启停各收集一次 `packages/deep-engine/src`+`wgsl`+本目录源哈希,前后逐键一致(sourcesFresh=true)。

## 4. 跨端像素对拍明细(Native 记录面)

10 锚点跨端(actualError = |web_actual − native_actual| 按通道最大;attribution = web 未量化 base/p0/p1 对 native 记录的未量化父响应):

| pixel | xy | actualErr | oracleErr | attr base | attr p0 | attr p1 |
|---|---|---|---|---|---|---|
| 0 | (0,0) | 0.000244 | 0.000244 | 0.000084 | 0.000359 | 0.000040 |
| 1 | (1,0) | 0 | 0 | 0.000086 | 0.000359 | 0.000039 |
| 30310 | (102,118) | 0.000488 | 0.000244 | 0.000148 | 0.000018 | 0.000044 |
| 23688 | (136,92) | 0.000122 | 0.000244 | 0.000143 | 0.000001 | 0.000040 |
| 24206 | (142,94) | 0.000122 | 0.000244 | 0.000143 | 0.000001 | 0.000040 |
| 27293 | (157,106) | 0.000122 | 0.000244 | 0.000143 | 0.000001 | 0.000040 |
| 37740 | (108,147) | 0.000244 | 0 | 0.000147 | 0.000690 | 0.000044 |
| 39864 | (184,155) | 0.000244 | 0.000244 | 0.000086 | 0.000019 | 0.000053 |
| 47259 | (155,184) | 0.000244 | 0.000244 | 0.000086 | 0.000019 | 0.000053 |
| 49267 | (115,192) | 0.000122 | 0 | 0.000082 | 0 | 0.000044 |

即:跨端 final 像素差 ≤ 0.000488(1 binary16 ULP),且跨端**未量化父响应**差 ≤ 0.000690——两端在同场景的每层父响应本身就对齐到千分之一个门内,final 差异主要来自 binary16 量化格点归属。

## 5. 原门是否原样

是。`layeredGate` = native 原门同定义(actual HDR16 vs 未量化父凸混合的硬件存储量化,全 65536×3 逐点 ≤0.002);无降门、无挑点、无新容差;三负控门限同 native(>0.001);coverage0/alpha0 恒等;raw 门并行;两 fresh 独立浏览器进程且逐帧 hash 一致(组合行两 fresh 同强度)。

## 6. 诚实条款

1. **全帧 65536 点的 web↔native 直接逐点对拍不可执行**:native 测试无像素 dump,本轮禁 cargo 不可补采;跨端可比集如实限定为上述 10 记录像素 + 两端各自同定义全帧原门(native 0.000488 已录,web 本轮 0.000244) + 聚合/负控/未量化父响应对照。此为本报告的可对拍最大范围,不伪造等价。
2. 观察器语义差异已守卫:native 4x MSAA resolve 允许尾数块落 binary16 格点;web 单采样直存,块值严格整数(守卫更严,`inexact==0`)。
3. 本机单 adapter;"两 fresh"= 两个独立 Chromium 进程(chrome 路径 `C:/Program Files/Google/Chrome/Application/chrome.exe`,`--enable-unsafe-webgpu`),非两块物理 GPU;跨驱动/跨机型未扫描。
4. Web 侧 parent 包未走 bitcast 观察器时的普通(非分层)材质路径曾出现"纹理不采样"假象,**根因为本轮 fixture 构造 bug**(parentMaterial 解构把纹理槽剥除),非生产缺陷;修正后同 fixture 的普通纹理父渲染与分层路径逐点自洽(rawGate 9.5e-7)。调试用的启发式猜测(esbuild alias/revision 方案)已全部撤除,最终 probe 为 native 逐包独立语义的最小形态。
5. 证据目录内 .bin/.f32 为两 fresh 的原始帧(各 10 帧 HDR16 + 4 帧未量化 f32),供复核;`evidence.json` 含全部门值、源冻结哈希、bundle 哈希、chrome 路径与时间戳。

## 7. I-C23 行剩余盘点

本轮闭合行报告第 6 节缺口 1(浏览器双端同场景像素级对拍)。行内已闭:Native 按层 RGB+MR/独立 UV/alpha/replace+overlay 真帧两 fresh;双端白炉;组合双端 24 帧;正确 dΩ 5 层栈 CPU 炉;public 作者 package 例;304B/纹理生命周期;**本轮:同场景(相机差 9.5e-8)双端像素对拍 + Web 全帧原门两 fresh**。

行外遗留(不属本行,按既有 owner 审计):Studio 层 UI、未来材质瓣(transmission/任意 dielectric aniso)、`remaining-tasks-estimates-20260930.md` I-C23 行状态更新(由 root 按本报告执行,本会话未改该行)。
