# J2-B6 Fog 合法模式、height与HG实帧矩阵

日期：2026-09-30。复用正式Web march/composite和Native OutputPass，按各自合同验证全部像素；不再运行共同optical-depth1024标量或已有单点fog_gpu。

## 现状核查

| 六步 | 已有（不重建） | 真实缺口 |
|---|---|---|
| 1. 源码/未跟踪 | 已查Fog源、GPUprobe及git status。Web体积march/composite、作者linear/exp2/8步volume和Native OutputPass exp/volume均已有消费。作者exp2与Bloom实纹理已独立完成。 | height/HG合法边界、两种高度坐标和整个实际输出没有同夹具profile证据。 |
| 2. 契约 | 已读VolumetricMedium/PassOptions/Result、PbrFog、Native FogSettings、frame ABI。Web steps32–64、scaleHeight>0、extinction0–100；Native steps1–64、height1–256、density0–8；两端g均−.99..+.99。 | Native无作者linear合同；Webmarch没有世界eye高度入口，不能伪造共同相机高度。 |
| 3. 依赖 | package/Cargo既有esbuild/Vitest/Playwright、wgpu30/bytemuck/serde_json即可。 | 不加第三方体积平台/生产资源。 |
| 4. 消费 | Web VolumetricFogPass::encode及CompositePass::encode进入PBR链；现volumetricFogPassCpu为整帧执行规范。Native OutputPass公开new/draw，正式shader从4xMSAA depth取min并读frameProjection/eye/Profile。 | Webscatter没有COPY_SRC，可复用已有lab纹理load拷贝读取；Native固定深度clear即可实际全帧射线，不需要新Fog shader。 |
| 5. 测试/证据 | 原G7 GPUprobe有NPOT/geometry/sky、2round稳定CPU比较；Fog共同核1024实际向量已过；C18 godrays另线已实际接。 | 原G7固定g.3/H8/steps48，未覆盖HG两端/height两端；Nativefog_gpu只检查改色。 |
| 6. 规格 | 已读B6current-state、common-fog、actual-frame核查、Bloom实纹理和剩余计划。 | 剩余是合法模式/坐标/相位的明确实帧矩阵；不把各自效果强迫同值。 |

## 最短完整边界矩阵

32×16 rgba16f HDR，alpha循环0/.25/.5/1；固定正深度10与天空，公开默认frame camera及近远面，记录实际frame。八种体积profiles：zero、g0/H8/steps32、H1、H256、g−.99、g+.99、steps64、sky。Native另测exponential与steps1；每profile世界eye.y为0/8，固定projection/basis，每case两draw。Web按视图原点同介质和光照合法域，正式半分辨率scatter+全分辨率composite均全像素参考，sky用既有maxDistance合同。Native全分辨率显示域按正式worldray、relativeHG分母floor.01/clamp0..4和固定步数mix验证；Web标准HG含1/(4π)、albedo/lightRadiance和透射提前终止保留。

事前半精度误差门沿已验profile标准 `abs <= .003 + abs(reference)*.004`，alpha精确保持，完整输出两draw稳定，GPU错误0。HG本身按各自公式核算，不改参数或忽略边缘求相等。Native steps1/height256/g合法端点另保留合同检查；Websteps<32/scaleHeight<=0明确非法，Native无linear模式保持能力差异。

作者linear与作者8步volume是Web独有profile，复用同原85点/两相机可另外2profile实帧；共同exp2已有证据不重复。模式合法差异、采样/合成坐标写入报告，J2-B6的数学/profile范围可据实收口，完整场景美术与性能验收仍按总计划最后执行。

## 实际结果

2026-09-30：Native具名actual40个OutputPass输出通过，GPU0.81秒；Web两个fresh device各16帧，每帧正式半分辨率scatter和全分辨率composite。144组、61440像素按各profile全像素CPU比较通过；Native最大绝对误差0.00048828125，Web最大绝对误差0.00390625，在预注册幅度+绝对半精度门内。alpha精确保持，两draw/两个fresh Web设备完整哈希稳定；Native实际eye0/8产生预期不同输出，固定camera/near/far/rawdepth/medium/light与profile输入均通过。

Web参考明确复用 `volumetricFogPassCpu` 现有执行镜像，再按半精度store和正式composite采样计算；Native是从实际frame/rawdepth出发的独立worldray/profile oracle，另校验frame与事前fixture一致。没有把Web镜像改称独立算法，也没有按实测结果修改profile参数/容差。

本次分段汇总 `test-output/interrupted-0930/fog-profiles/evidence.json` 为 `currentRun=false`，日志 `fog-profiles-native.log` 保留。统一fresh入口 `node scripts/j3-fog-profile-parity.mjs` 顺序具名Native一次和两个fresh Web设备，只有默认统一入口赋true；`--web-only`跳过Cargo/Native并比较存量Native；`--compare`仅读已有receipt。Source身份只覆盖实际esbuild闭包与Native Output/Fog正式依赖，未纳入无关mesh测试或全src新文件。

另加Web合法作者linear与八步volume矩阵，沿原85点、两相机、两draw、两个fresh设备，680点通过；最大CPU误差0.00024394011737843835，预注册绝对门0.001。命令 `node scripts/j3-web-author-fog-modes.mjs` 始终是明确Web-only fresh门，`currentRun=true`仅表示该专项本次执行；Native没有作者linear合同，未计为Native同模式。共同exp2、原1024标量和旧fog_gpu没有重跑。

作者模式两张实际1920×1080深色截图已核看非空，图形/位置与颜色稳定。首次截图在dispose之后取图而为空白，原PNG及首次数值通过receipt以 `before-screenshot-fix` 文件名保留；观察回调移至dispose前，仅重跑该Web专项，原数值与门保持相同。没有重复其它Fog/Bloom门。

CPU检查：lab TypeScript、Fog参考2项/Node比较器2项/作者模式3项通过，三个新runner语法、Native rustfmt及diffcheck通过。Fog主题9叶子文件及Web作者模式4叶子已冻结；本刀未改production、既有fixture、GPUpass、HDR/shader。B6的数学复用、合法模式/height/HG与Bloom纹理范围已具实际证据，完整工业场景画质、RT与性能保留原J3-D/后续验收范围。

## J5 profile门接入：现状核查与边界

核查六步：已查scripts判据关键词与未跟踪runner；读GATE_PAIRS/leg/currentRun合同；确认Node test/esbuild/Chrome/Cargo现依赖；定位J5 executeGate按command去重消费；读既有编排自测与B6实际receipts；对齐本规格/Bloom规格/J5窗口规格及剩余表。已有双腿调度与失败传播不重建；真实缺口是已验Bloom/Fog profile runners还未纳入强制判据。

新增Bloom实际全纹理与Fog合法profile两对，各端共用同一次默认fresh runner，沿既有command去重；禁止--compare/--web-only替代strict腿。当前判据16对32腿，CPU编排自测只验证调度与失败传播，不把它写为实际32腿全通过。原14对历史结果保留，完整strict总批按用户要求留最终验收。