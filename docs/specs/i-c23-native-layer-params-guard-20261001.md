# I-C23 Native 分层参数发布守卫

直接 Native JSON 输入在合同校验时拒绝未求值的活动扩展瓣，并校验所有层参数数值域。

## 现状核查

1. 全仓检索 layered/clearcoat/anisotropy/transmission/ior，并核对 git status 未跟踪项。Native typed layered 参数、打包叶、实际 WGSL 与合同测试已有；没有参数支持分类叶。四项保护内容与并行源保持原样。
2. 契约已读 Native contract/types、validate、TS materialParameters/materialLayeredParameters/materialLayeredSurface、runtimePackage parser：IOR 为有限 float32 且≥1，coat factor/roughness、aniso strength、transmission factor 为0..1，rotation仅有限并由TS规范化；coverage缺省0，factor/strength缺省0，IOR缺省1.5。
3. Cargo 已固定 serde/serde_json/wgpu；本刀无需依赖或ABI改变，复用现有serde闭字段/模式合同。
4. 消费方：直接load_and_validate与validate_packet进入现有layer validator；prepare层行仅coverage>0入304B块。Native layer shader只消费IOR，其余扩展瓣未求值；基材scene_pack读取material.ior而不读取layered.base.ior。TS prepareMaterialTextures已有baseIOR一致性校验，不重建该TS门。
5. 已查pbr_layered_contract_tests、参数/打包测试、最终dist公开SDK复现。旧validate只检查层数/coverage/surface，对参数数值与支持域缺守卫；独立实际serde→validate修前复现与修后检查使用既有serde rlib和真实合同模块，由rustc运行，未调用Cargo/GPU。
6. 已读i-series-next-cpu-audit、finaldist-native-profile-repro、I-C23消费/白炉/RT规格、remaining/交接/ledger。扩展瓣求值与本支持边界修复分开，既有layer颜色/MR/纹理/UV/白炉/RT成果不重建。

已有（不重建）：层合同、数值surface/coverage校验、纹理引用/UV校验、304B打包、混合/剪枝、TS参数规范化与baseIOR门。

真实缺口：直接Native入口未拒非法params，活动层和活动栈base的非零未支持瓣可发布；Native基材IOR与声明baseIOR不一致的直接输入是否已拒由修前真实执行确认。

## 最小边界

所有base/层params数值均验证，包括零coverage或空活动栈；支持门只针对coverage>0层和存在活动层时的base。coat.factor、aniso.strength、transmission.factor非零拒绝。合法零coverage扩展数据保留；零因子roughness/rotation允许；rotation不人为限±π。错误标明material、layered.base/层序号、params具体字段。旧层数/coverage/surface检查仍走原函数。

与SDK专线已确认默认值及支持域；未引入新错误码类型，使用现有Result<(),String>。J5冻结期间仅草稿写ignored test-output；主线宣布32腿strict通过并解锁后才接线Native源。

## 修前复现与实现

实际当前合同8模块加既有serde/serde_json rlib经rustc编译；非空fixtures/render_packet_v1.json直接反序列化→validate_packet。baseIOR1.2/stock默认1.5、active clearcoat.factor=.7、coverage0/params.ior=.5 **三项均accepted=true**，验证输出为2 geometries、2 materials、4 instances、13 triangles。日志 `test-output/i-c23-native-profile-guard-20261001/before.txt`。因此直接Native入口也补活动栈baseIOR一致性门；TS既有门不改。

新增 `contract/validate_layered_params.rs` 在validate_packet原层数/coverage/surface检查后调用。参数域先验证全体，支持域后验证活动base/层。有效baseIOR缺省1.5，stockIOR缺省1.5；只在存在coverage>0层时比较。有效输入检查无堆分配，只在错误路径格式化字段。serde的闭字段/null/类型/混合模式拒绝继续沿用。

## CPU 验证与冻结

独立真实合同模块rustc测试 **8/8**，包括108次 base/active/zero/empty 栈的非法数值检查、三瓣×两层索引、活动base三瓣、覆盖缺省/零覆盖携带、零因子rough/rotation、layerIOR、baseIOR匹配/缺省不匹配、旧surface/coverage门、serde未知/null/类型与输入不变。使用实际types/validate/helper源码，没有类型替身。旧packing/GPU测试未改；root完整Cargo接线验证仍待执行。

编译：`rustc --edition 2024 --test test-output/i-c23-native-profile-guard-20261001/after.rs --extern serde=packages/deep-engine-native/target/debug/deps/libserde-30b65227d0a51f28.rlib --extern serde_json=packages/deep-engine-native/target/debug/deps/libserde_json-83f8489bc50ae029.rlib -L dependency=packages/deep-engine-native/target/debug/deps -o test-output/i-c23-native-profile-guard-20261001/after.exe`；执行该exe `--nocapture`。编译无warning，rustfmt与限定diff-check通过。

引擎source-size门：files=2922、warnings=175、failures=0，原始日志 `source-size.txt`。只读检查完成后Native源保持冻结。

新叶 **149/202 行**。冻结SHA256：mod.rs `3b78bd07dea722a3da23f8de6de5274605c3d2dde62d4bc9177a7891acdfc9d9`；validate.rs `325809804e54d356c1955879ce010af1b13e2a59592589246b8fa1ae4d251db9`；helper `11c2b86d3957b5c70f3163907e910f75289ca26f393697d65cc36dc3e8f0c437`；tests `2a7d1e7d168baa80ed717e94ad4e800bb8e04e7d2fba093040f89fb8b8244ab8`。

root精确完整接线验证：在仓根 `cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --lib native_layered_parameter_guard -- --nocapture`；既有分层合同回归 `cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --lib pbr_layered_contract_tests -- --nocapture`。本专线没有跑Cargo/GPU、没有commit/push。Native源随后WASM/广义GPU指纹须按真实变更更新，旧J5 receipt不宣称新源fresh。
