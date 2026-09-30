# Native DFG 的相关Smith积分

让Native既有DFG生成器与主光GGX用同一相关Smith模型，保留32²×128内置预算和128²导入分辨率。

## 现状核查

1. 全源/未跟踪：Web environmentShader.brdfMain已在S5消费deepSharedGgxVisibility，Native ibl.rs仍用k=rough²/2的独立Smith乘积；没有第二DFG生成器。现粒子/GS草稿不相关。
2. 契约：PreparedIblTexture2d、builtin/default及panorama导入都消费同generate_brdf_lut；尺寸/texels/provenance/公开v1合同保持。
3. 依赖：现Rust标准f32运算、Cargo测试、wgpu/naga已足够，不加库。
4. 消费方：builtin与panorama经GpuIblEnvironment上传binding5，Native主光共享多散射和IBL都消费这个LUT，不能只改未消费数学叶子。
5. 测试：现ibl_contract、runtime_package_prefiltered_ibl、实际Native主光与白炉底座；原k模型缺独立相关Smith数值核对。
6. 规格：c8-native-direct-energy与S5明确此真实差异。这里只对齐积分模型，不强行扩大默认分辨率/采样预算，不以此宣称Native/Web默认纹理相同。

已有（不重建）：GGX/Hammersley采样、LUT存储/验证/上传/既有两入口、共享BRDF物理语义与实机测试宿主。
真实缺口：将积分visibility换为Web相关Smith表达式，独立f64预登记点oracle及原IBL/主光/白炉回归。

## 预登记

固定x=[2,15,29]、y=[8,16,29]的9个32² texel；独立f64重要性积分128samples，绝对误差2e-5。与旧非相关Smith oracle必须有大于1e-3的区别以防空改；预算与shape不变。原底层32²/128samples合法profile差异仍保留。

## 已验范围

独立相关Smith积分1测、IBL合同5测和运行包预滤波4测通过，日志 `test-output/interrupted-0930/c8-native-dfg-cpu.log`。正式Native白炉复用此内置LUT并经原GPU绑定上传：球/墙2测通过，球几何p99误差约0.049%、墙误差0、色漂移0，日志 `c8-native-dfg-furnace-actual.log`。初次带`--ignored`的筛空命令未计入通过。

共享Native着色器9测、局部灯夹具1测通过，生产材质/LOD/CSM/透明度控制2测通过。主光与局部灯constant-DFG差分属于另两规格；这些门不认证32²默认Native与128²Web纹理逐像素等价，也不认证完整C8或真实RT设备。
