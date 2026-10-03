# J3 独立比较采样精度

## 现状核查

1. 已检索packages/apps源、未跟踪源与J3完整场景审计，正式CSM和两端comparison sampler已存在；没有已有固定输入实际精度校准。
2. 读取cascadedShadowResources、Native shadow_map与测试wgpu GPU buffer/view合同；只加测试叶，不改运行ABI。
3. 读取Cargo.toml、现有wgpu/pollster/bytemuck/serde与esbuild/Playwright依赖；不新增依赖。
4. 正式Web descriptor为less-equal/linear、Native同过滤且lodMax=0。实际阴影shader消费3×3 PCF；沿各端原descriptor，保留lod差异。
5. 读取固定轴/双轴/棋盘输入、CPU reference、具名Native入口、Web实际probe和源结束守卫；CPU两测先验，GPU原样核验上传Float32及64个实际深度texel。
6. 读取权威J3-D行、完整工业关闭复核、CSM实际32帧与source-oracle记录。工业输出不用于构造输入，也不用于拟合接受预算。

已有（不重建）：实际阴影图、PCF与完整工业附件。真实缺口：当前设备比较过滤的坐标/输出精度缺少独立实际观测。新增三个tests/support叶与具名registry入口，固定四个4×4深度layer、每device16388查询、双端各两fresh；源码before/after守卫。观察结果不自动放宽工业门，旧失败保留。

根路已读取全部三个Native叶、Webprobe、reference与runner，核对两端descriptor与生产源相同；批准测试提升。GPU入口`node test-output/j3-compare-sampler-calibration-20261001/run.mjs`，执行前核实8个冻结叶并独立重跑CPU。计数不变。

## 实际观测

CPU两测通过。首次Cargo编译因测试叶使用旧wgpu API失败，保留`jc-i-20261001-j3-sampler-gpu.log`及首run failure。按现wgpu30修为ShaderSource::Wgsl、Some深度字段和ErrorScopeGuard::pop，root单叶before/after SHA提升；生产shader/采样器不改。

复跑`jc-i-20261001-j3-sampler-gpu-fixed.log`退出0，具名Native实际测试1项0.88秒。证据`test-output/j3-compare-sampler-calibration-20261001/run-2026-10-01T09-30-11-837Z/evidence.json`为passed/currentRun/gpuExecuted全true，双端各两fresh完整输出稳定。每device16388查询/64实际depth与所有上传Float32逐值验证；两端轴向257输出级、最小步长1/256，轴向理想最大误差1/512，双轴棋盘误差上限与PCF另保留。root独立生产及观察源核对收据`test-output/jc-i-20261001-sampler-source-verified.json`。这些是独立固定输入观测，工业准入仍需源公式/负控验证，不直接拿最大观测误差放宽门。

## 完整比较掩码补验

四类固定输入导出的守恒权重模型在独立single/PCF上全0，应用工业源参考仍有残差，保留反例，不关闭D。最小真实缺口是原输入未辨识全部16种2×2比较掩码；沿上述六步既有descriptor、query/输出合同与依赖扩展独立16层，新增三个support叶和具名registry，不改原校准与生产。每mask固定4097对角、4097混合、1024固定种子二维位置，总147488查询/device、256真实深度texel；不消费工业位置或输出。root已读取新源/runner，CPU三测与8叶SHA通过；实际双端各两fresh全部通过，589952输入Float32 lane及256实际depth逐值验证，完整single/PCF模型0误差。证据`test-output/j3-compare-sampler-masks-20261001/run-2026-10-01T09-43-36-704Z/evidence.json`；root独立4945源SHA复核见`test-output/jc-i-20261001-sampler-masks-source-verified.json`。本机vulkaninfo实际RTX4060Laptop设备限额为subPixelPrecisionBits=8、subTexelPrecisionBits=8、standardSampleLocations=true，原日志`test-output/jc-i-20261001-vulkan-device-limits.log`。工业剩余actual world/PCF读回另做同源诊断，不由校准子集关闭D。
