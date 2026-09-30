# J3 Gate E 实际设备重开首刀

日期：2026-09-30。验证实际device销毁、lost观察、旧宿主退役、相同CPU包重传及有效首帧；不改变生产恢复策略。

## 现状核查

| 六步 | 已有（不重建） | 真实缺口 |
|---|---|---|
| 源码/未跟踪 | 已检索packages/apps的device.lost/destroy/recovery和git status。Web DeviceSession、PbrRenderer、GPU驻留executor；Native gpu_context/app recovery、GpuScene与生产帧helper均存在。输出/C8/B5在途文件保持原状。 | 没有同manifest、同阶段的两端实际destroy/recreate门。 |
| 契约 | DeviceState/DeviceRecoveryEvent、Runtime package/RenderPacket、GpuEvent DeviceLost、Gate E CPU阶段合同已存在。 | CPU发布阶段不是GPU阶段；需要独立且窄的device-epoch合同。 |
| 依赖 | Chrome/Playwright、esbuild、Vitest、wgpu30、pollster、serde_json、现有像素读回/half decoder在用。 | 无需恢复平台、窗口宿主替身或新依赖。 |
| 消费 | Web lab/main真实loss操作经PbrRenderer destroy→lost停止→dispose→create→上传→validateFrame；Native gpu_context注册lost callback，app/recovery丢弃Renderer重建。shader_material_renderer消费正式GpuScene和pipeline，真实HDR/四CSM读回。 | Web显式destroy是不可恢复终态，不能改reason冒充C13 unknown-loss自动恢复；Native旧RT恢复测试在同device上drop/rebuild，未实际destroy。 |
| 测试/证据 | DeviceSession.recovery单测有unknown-loss/retry/retire；gpuResidencyProbe有actual destroy；Native rt_recovery、ShaderPackage foreign-device HDR/CSM精确测试已存在。 | 前者部分mock，后者没有实际lost callback与device.destroy；不能替代同阶段实测。 |
| 规格 | 已查Gate E CPU规格、剩余J3-E-GPU、C13报告、RT恢复测试说明。 | C13自动恢复与完整编辑器恢复未在本刀验收；GPU驱动显存读数也未纳入。 |

## 共同输入和范围

唯一场景来源是现有`deep-engine-native/tests/fixtures/runtime-package-shader-v2.json`。双方读取同一RenderPacket payload，校验相同包hash及原payload SHA-256；Web用正式materializeRuntimeRenderPacket/PbrRenderer上传，Native用正式runtime package parser/PlayerContent/GpuScene上传。两端材质/灯光/相机宿主适配不同，本刀只要求各自销毁前后有效首帧稳定，不要求两端像素相等。

GPU阶段：initial-device → uploaded → first-valid-frame → lost-observed → old-host-retired → recreated → uploaded → first-valid-frame → disposed。阶段在真实动作或可验证GPU读回后记录；lost必须实际回调/Promise到达，设备身份必须不同，超时/空帧/帧漂移均失败。销毁注入的reason保持destroyed，恢复由外层宿主重开；Native通过现成生产帧helper重建组件，范围不包含winit NativeApp事件分发或窗口present。

首帧用实际生产HDR/阴影附件读回确认有限、有场景绘制及销毁前后相等。Native角落须匹配ForwardTargets默认clear RGB（0.012/0.020/0.035），相对实际角落有差异的HDR像素必须大于32，CSM深度小于clear 1的样本必须大于32；清底色本身不算几何。Web角落须匹配指定黑背景，非背景HDR像素、drawCalls及triangles均须非零。资源归零若记录，只能来自Web session所有权账本，不能写成驱动显存；Native场景资源随helper/旧device退役，不虚构资源计数。GPU单端与Cargo由主线串行执行。

## 实现与验收入口

Native在既有shader_material_renderer真实draw/readback尾部加入test-only observer，scene/CSM/targets/pipelines/culling/LOD owner跨过实际lost回调才退役；原render/render_checked调用保持原行为。Web复用PbrRenderer/DeviceSession/正式包物化器和已有附件读回。关闭TAA的恢复fixture无motion MRT；读回helper新增默认保留motion必需的选项，恢复probe显式只观察实际HDR/CSM（motion占位为0，未验收运动矢量），不为观察开启TAA。每轮销毁前/重建后实际首帧各保留截图，共两轮四张。

唯一完整命令：`node scripts/j3-device-recovery-parity.mjs`。默认先删除旧native/web/evidence，再执行本次具名Native测试，要求成功日志和非零passed；随后才运行Chrome两轮。`--compare`仅历史文件比较，`--web-only`仅Web本次证据；二者都不能报告双端当次验收。Cargo默认捕获stdout，避免helper打印插入testname与ok之间误判。

纯CPU门：`node --test scripts/lib/j3DeviceRecoveryParity.test.mjs`；类型检查：deep-engine目录执行`pnpm exec tsc -p tsconfig.lab.json`。最终GPU结果由主线串行回填。本刀不验收自动unknown-loss、NativeApp窗口事件/present、跨端像素、驱动显存、GPU帧时或完整编辑器状态恢复。

## 已实测证据

主线Native本次GPU具名测试通过，两轮各6611非背景HDR像素，生产owner保持驻留至actual lost回调，重建前后HDR/四CSM完全相同。主线`--web-only`定位运行通过，两轮各239非背景HDR像素、loss时各152个生产账本资源；重建前后HDR/CSM完全相同，最终session资源数及其估计拥有字节均归零。

随后主线在严格J5门中执行默认runner，双端本次fresh运行通过（13.9秒命令墙钟时间，非GPU帧时）；每端两轮、每端18个真实阶段记录、`currentRun=true`。严格J5总体9对18端通过、`degraded=false`，总门证据为`evidence-20260930052206.json`。该GPU设备epoch切片完成，完整J3 Gate E及上述排除范围仍待后续。

共同包身份：`71c978b477056ee991cd495e2dca809245a4bc81bd81e26432ce7089996ae67c`；共同实际RenderPacket payload SHA-256：`0c29a0ed6301d1360c9fb40a4dce117b7f97896837a735d1e54bb81f116104d4`。证据位于`test-output/interrupted-0930/device-recovery/`。已查看`frame-0-before.png`及`frame-1-after.png`，固定fixture三角几何可见、销毁前后画面一致；四张截图均在真实首帧仍驻留时拍摄。这是恢复数值fixture，不是产品画质验收。

本次纯Node门5项、lab类型检查、浏览器依赖打包、rustfmt及改动diff空白检查通过；新增文件均小于300行。全仓800行检查仍有既有超限项，不属于该数值门的通过结论。
