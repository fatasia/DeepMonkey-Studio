# J2-B6 非均匀 Bloom 实际纹理矩阵

日期：2026-09-30。对同一半精度HDR输入运行两端既有Bloom生产pass，分别验证正式profile，记录算法差异。

## 现状核查

| 六步 | 已有（不重建） | 真实缺口 |
|---|---|---|
| 1. 源码与未跟踪 | 已检索packages/apps的Bloom、pass、output和git status。Web BloomPass/AuthorBloomPass、Native BloomPass/OutputPass均已有。I Gaussian、C8和作者雾已验源保留各自所有权。 | Web旧Bloom已有均匀/亮斑能量门，未对完整非均匀纹理跑独立逐中间half-store参考；Native只量亮斑扩散/暗区。 |
| 2. 契约 | 已读BloomOptions/BloomResult/Native BloomSettings/OutputColorProfile及contracts场景后处理。Web阈值0–65504、强度0–16、4–12级；Native阈值0–64、强度0–4、radius0.5–2。 | 两种合法算法不能按同名参数强制逐像素相等。作者Rec.709是第三模式，已有独立CPU/GPU门。 |
| 3. 依赖 | 现有esbuild/Vitest/WebGPU及wgpu30/bytemuck/serde_json/pollster足够，已读package/Cargo。 | 不新增库、资源平台或截图平台。 |
| 4. 消费方 | Web PbrPostProcessChain调用BloomPass，默认threshold1.25/softKnee.2/intensity.55/maxLevels5。Native renderer用BloomPass及OutputPass，默认threshold1/softKnee.5/intensity.14/radius1。Native cfgtest output_texture已有COPY_SRC，OutputPass::new支持rgba16float且draw公开。 | 复用该真实factory读取32²blurred和64²显示域输出，不能把Native显示域混作Web线性HDR。 |
| 5. 测试与证据 | bloomEnergyReadback支持任意pixelAt；authorBloomReference逐中间半精度CPU已存在。Native bloom_gpu/fog_gpu已有真实pass/readback；共同prefilter64向量GPU稳定通过。 | 缺纹理采样/边界/正负通道/非恒定alpha全像素profile对照；不重复软膝标量和作者Bloom。 |
| 6. 规格 | 已读B6current-state、actual-frame后继核查、Bloom/Fog规格与恢复记录。作者exp2原85点实帧已单独交付。 | Bloom全纹理和体积/HG合法模式仍后继，不扩为全帧画质或性能完成。 |

## 冻结矩阵与观察语义

使用64×64固定输入：均匀HDR、中心4²亮斑、边缘4²亮斑、渐变、正负checker、阈值两侧条纹。alpha循环0/0.25/0.5/1，全部源先编码为rgba16float；记录全部像素和输入哈希，每profile两次实际绘制。

Web沿生产默认5级，box采样后非负化、整数5tap、0.5逐级重建和全分辨率线性HDR合成。Native沿默认半分辨率，±0.25线性采样后非负化、分数偏移5tap/radius1，读取实际blurred texture；同时用原公开OutputPass生成全分辨率显示域ACES/sRGB。Native强度、Web强度和blur模式按原默认保留，不换参数追求相等。

独立CPU参考按原坐标、clamp/线性采样、软膝policy和每次半精度store计算。全部像素独立比较，事前误差门固定 `abs <= 0.003 + abs(reference)*0.004`，沿用已有作者Bloom half-store门。alpha须精确保持，两次输出完整哈希稳定，GPU错误为0。Web线性HDR与Native blur/显示域分别标注；对共同输入的profile差异仅诊断，不设置虚假跨算法相等门。

## 实际结果

Native具名actual12帧已由主线程执行通过，GPU0.85秒。Web两个fresh device各12帧也通过。按三种实际输出分别检查72组、221184像素，所有像素在事前half-store门内；alpha精确保持，两次绘制及两个fresh Web设备完整输出hash稳定，GPU错误0，Web资源释放后0。亮斑HDR最大绝对误差0.015625，Native显示域最大绝对误差0.00146484375；门同时包含幅度项，不将HDR误差与显示域混淆。

同一显示域对原默认profile作诊断：中心亮斑最大差0.3716280081、边缘亮斑0.3669998875，均匀0.0194608358。双方原强度0.55/0.14、blur/级数与采样策略保持，各自CPU参考全像素通过，跨算法相等不在合同内。

本次分段Native/Web实际汇总 `test-output/interrupted-0930/bloom-texture/evidence.json` 明确 `currentRun=false`。统一fresh入口 `node scripts/j3-bloom-texture-parity.mjs` 顺序具名Native一次和两个fresh Web设备，每设备两draw；只有默认统一入口赋true。`--web-only`跳过Cargo/Native并比较存量Native，`--compare`仅读已有receipt。源码身份覆盖实际esbuild依赖闭包及Native实际Bloom/OutputPass依赖、canonical kernels，运行前后相等。

CPU检查：lab TypeScript、Vitest2项、Node comparer2项、runner语法/rustfmt/diffcheck通过。日志 `bloom-texture-compile.log`、`bloom-texture-native.log` 保留，逐像素原receipt和CPU-plan在该证据目录。

独占new fixture、lab/reference/probe及test、Native standalone test、runner/comparer与本规格共9文件已冻结；production算法/资源/阈值/输出profile未改。作者Rec.709沿既有完整CPU/GPU门，体积/HG模式下一刀，不将本矩阵扩写为完整产品场景画质或帧时。
