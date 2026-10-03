# J3-D 逐层源身份与新鲜度

补几何、深度、HDR和显示层的实际生产源身份，沿用既有GPU比较器；聚合时检查当前源与真实执行收据。

## 现状核查

1. 检索 packages/apps 与未跟踪项、现有 J3 runners：八层已有生产读回，J3-D聚合34格；四层缺生产源digest。
2. 已读 RenderPacket/scene合同、层目录类型和六门绑定；不新增生产协议或改变数值门。
3. package.json/Cargo.toml已有Node、esbuild、Playwright、wgpu；不新增依赖。
4. geometry-depth runner实际消费PbrRenderer与Native shader_material_renderer；display runner消费outputShader与Native OutputPass。已有snapshotWindowRecoverySources捕获完整生产链，法线/阴影已用。
5. 已读几何/HDR/矩阵Node测、lab矩阵测与最终J5 receipt evidence-20261001061146.json：32腿通过，四层实际已跑但收据无法独立证明当前源码。
6. 已读J3-D CPU准备、剩余锁定行、交接和恢复台账；完整场景产品画质与性能不能从分层数值门推断。

已有（不重建）：八层附件、GPU runners、独立参考、门合同、合法差异登记、生产源扫描器。

真实缺口：四层未记录/复核源身份；display失败前未失效旧成功收据；聚合只提供历史比较模式。此次补前后hash守卫、失败失效与新鲜生产收据核验模式；原0.002/SSIM/深度/显示字节门不变。

纹理覆盖已有七配置×两相机、双fresh真实runner与当前源收据，但未入层目录。补第九层与14个冻结场景格，复用其独立UV/MR/alpha比较器；配置来自texture fixture，相机来自同一HDR manifest，不在读回后挑选。补scope/profileHash绑定与stable声明，不改变算法或门。

## 验证

Node geometry/HDR/source-matrix 26项与九层/texture合同23项通过；lab matrix+C8输入16项通过，lab tsc通过。display用无效Chrome路径的失败试验退出1且旧evidence已失效，随后实际具名Native与两fresh Web通过。

几何、HDR、display真实新收据通过；texture两fresh每端638稳定点，最大跨端HDR差0.00048828125、独立参考差0.00047457864，边界仍沿原1px合同。九层48格聚合 `--verify-fresh` 通过：freshnessVerified=true、currentRun=false、无新鲜度提示。日志 `test-output/jc-i-20261001-j3-d-nine-layer-fresh.log`，该聚合不执行宿主。

其后补入实际消费的lod_draw_readback观察器身份，并提升Web恢复元数据/I23清漆源码；上述收据保留为变更前实际结果，当前源码需再跑生产腿。完整工业共同场景仍缺，不能据九层登记关闭J3-D；独立范围审查见 `j3-d-full-independent-closure-review-20261001.md`。

2026-10-01 16:42批次：I16 PBR/平滑法线、Native输入隔离/计时叶正式源之后，统一J5 `evidence-20261001081816.json`16对32腿全绿，degraded=false；纹理专项新两fresh638点/轮全绿，日志`jc-i-20261001-j3-texture-smooth-timing-final.log`。九层48格`--verify-fresh`同批次通过（currentRun=false、freshnessVerified=true、无提示），日志`jc-i-20261001-j3-d9-smooth-timing-final.log`。随后CSM生产两叶提升，故这些收据为CSM之前的冻结批次，最新统一门待集成结束重跑；新的完整工业实跑32帧source前后守卫通过，但strict=false，见[CSM实际修复](j3-csm-exact-profile-20261001.md)。

21:00最终登记：20:17真实producer刷新后的九层48格聚合通过，日志`test-output/jc-i-20261001-j3-layer-final-verified.log`，freshnessVerified=true/currentRun=false。随后无关作者/F6源变化触发旧广域guard时保留其measured batch，不将旧收据改SHA冒称fresh。当前完整core32帧通过原输出/材质/法线门，715阴影域与旧来源证书精确join；最终effects12:38:40实际64帧通过，4982记录源当前逐SHA和canonical digest复核一致。依据[最终范围裁定](j3-d-full-independent-closure-review-20261001.md)关闭J3-D-full当前行；source guard与后继有影响变更的必要回归继续保留，不以闭行代替新源认证。
