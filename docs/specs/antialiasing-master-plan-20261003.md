# 最强抗锯齿方案(Anti-Aliasing Master Plan,2026-10-03)

> 目标:在 WebGPU/桌面双形态上建立**分层、可组合、自适应**的抗锯齿体系,默认档位即接近离线质量;与 three(MSAA4+SMAA)同构组合下像素对齐,并超出(时域+alpha-to-coverage+线 AA)。
> 全部自研/开源内置(SMAA/FXAA/CMAA2 均为宽松许可,固定版本内置);禁外部依赖。

## 0. 现状基座

| 资产 | 状态 |
|---|---|
| MSAA 挂点 | `PBR_MAIN_SAMPLE_COUNT=1`,管线 `multisample`/目标 `sampleCount` 已接——**只差常量与 resolve 通路** |
| 时域重建 | T07 自研 TSR(temporalAa 通路,残影 2.93% 口径)+ motion vector 管线已有 |
| 空间 AA | Deep 自有 spatialAa(边缘算法,parity aa-bloom 诊断档 RMSE 6.05 的 Deep 侧) |
| alpha-to-coverage | WebGPU `alphaToCoverageEnabled` 原生支持,**未使用** |
| 自适应质量 | AdaptiveQualityController(档位/预算/hotspot)已有 |
| 对照基准 | three=MSAA×4+SMAA;parity 门 aa-bloom 场景可定量 |

## 1. 分层体系(四层)

### L1 硬件层:MSAA + alpha-to-coverage
- **MSAA 4x 主目标**(sampleCount=4;检测 maxSampleCount 支持 8 时开放 8x 档):color+depth MSAA、resolve 进后处理链;透明/OIT/线性深度等附属目标保持 1x(逐一论证,不盲目全 4x)。
- **alpha-to-coverage**:植被/链栅/栅栏/particles 的 alpha test 几何开启 `alphaToCoverageEnabled`——MSAA 的免费质量放大器,对工业安全网/格栅类资产是质变。
- 验收:三角/圆边缘梯度能量 vs 1x 下降 ≥70%;a-to-c 资产对比图。

### L2 时域层:TSR(主)+ 防鬼影
- **TSR 默认参与组合**(T07 内核):低动态场景重建到原生以上分辨率,兼 AA;
- **防鬼影三件套**:运动矢量已备 + **几何置信度(disocclusion mask)强化**——深度不连续拒绝历史、相邻深度差阈值自适应 α;**透明/粒子不进时域历史**(独立分支,避免拖尾);
- 残影门:2.93% → **≤1%**(旋转/平移扫掠场景逐帧差)。
- 验收:旋转扫掠逐帧差 p99 ≤2/255;disocclusion 边缘无拉丝(对比图)。

### L3 空间层:SMAA(替换 spatialAa)+ CMAA2(轻量档)
- **SMAA T2x**(开源固定版本移植到 WGSL:边缘检测 LUT+定向模糊+邻域取整,内置):作为**空间兜底与混合成分**——MSAA resolve 后、或 TSR 输出后轻量补一遍(SMAA 对时域残余阶梯极有效);
- **CMAA2**(可选轻量档):低功耗/集显设备档(比 SMAA 更省,质量略低);
- 现 spatialAa 保留为 legacy 档(合同向后兼容),默认不选。
- 验收:SMAA 后阶梯残余(频域能量)较输入 ↓≥80%;CMAA2 档帧成本 ≤0.8ms@1080p。

### L4 内容特化层
- **线框/CAD 线 AA**:工业线框、轨迹线、轮廓描边(instanceOutline)——线渲染走 screen-space 平滑(四边形展开+距离场边)或依托 MSAA(线几何进 MSAA 主 pass);instanceOutline 已有半分辨率边缘,升全分辨率;
- **文本/overlay**:DOM overlay 天然抗锯齿(不动);画布内 label(sceneOverlayVisuals 的 CanvasTexture)绘制时自带 AA ✓;
- **alpha 测试资产**:见 L1 a-to-c;
- **粒子上屏**:粒子走 OIT/加法混合,不参与 MSAA resolve 锯齿(混合模式天然柔边);曲线 LUT 密度复核。

## 2. 组合档位(暴露给用户/自适应的最终档)

| 档 | 组合 | 目标设备 | 帧预算@1080p |
|---|---|---|---|
| off | 无(诊断用) | — | 0 |
| fxaa | FXAA | 极低功耗 | ≤0.4ms |
| smaa | SMAA | 低功耗(默认低档) | ≤0.8ms |
| msaa2 | MSAA 2x | 集显 | ≤1.2ms |
| **msaa4**(默认) | MSAA 4x | 主流独显/Apple | ≤2.0ms |
| msaa4+smaa | MSAA4 → SMAA 补 | 高质量 | ≤2.6ms |
| **tsr** | TSR(+MSAA1) | 超分/低分辨率比 | ≤2.5ms(含上采样) |
| **ultra** | MSAA4 + TSR + SMAA(sharpen) | 旗舰/展示 | ≤3.2ms |

- **默认档=msaa4**("默认效果就很好");`displayContract.antialias` 扩展 `{ mode, msaaSampleCount, smaa, tsr }`(缺字段=现行为,向后兼容);
- **自适应**:AdaptiveQuality 按 GPU 余量在 msaa4 ↔ msaa2 ↔ smaa 间降/升(复用既有 hotspot 机制),TSR 在动态分辨率激活时自动接管;
- manifest 登记 `antialiasing` 能力条目(双端支持档)。

## 3. 特殊场景纪律
- **透明/OIT**:加法/混合链不进 MSAA 主目标(1x + 混合柔边),避免 resolve 撕裂;
- **拾取/诊断读回**:读 present-color resolve 纹理(readback 路径同步改);
- **路径追踪/离线**:不适用 AA(自身是超采样)。

## 4. 实施批次

| 批 | 内容 | 验收门 |
|---|---|---|
| AA-M1 | MSAA4 通路(常量+resolve+readback+回退)+ 默认档切换 + 帧时证据 | 帧时 ≤+2ms;parity aa-bloom RMSE 6.05→<2 |
| AA-M2 | alpha-to-coverage + TSR 防鬼影强化(残影 ≤1%)+ SMAA 移植(T2x) | 组合档全通;阶梯能量 ↓≥80% |
| AA-M3 | CMAA2 档 + 线 AA 全分辨率 + 8x 检测档 + 自适应组合 + manifest/文档 | 全档位证据矩阵 |

## 5. 指标体系(进 verify 与 parity)
1. **parity aa-bloom**:目标 RMSE <1(与 three 同构 MSAA4+SMAA 组合后);
2. **边缘质量**:边缘带像素梯度能量 vs 4x 超采样参考(离线路径追踪或 2x 分辨率渲染);
3. **时域稳定**:扫掠场景逐帧差 p99、残影百分比(T07 口径);
4. **帧预算**:各档实测(上表);
5. 全部门进 `verify:gpu-release` 与 QA 截图(1080p 深色)。
