pub mod adapter_n1;
pub mod benchmark_observer;
pub mod benchmark_workload;
/// atmosphere-sky 能力行(native 缺位补齐,2026-10-06):T09 解析单散射天空的
/// CPU 权威镜像 + WGSL 单源 + 全屏背景管线(TS skyReference.ts 同构;
/// 登记 supported/harness-only,生产背景 pass 接线为后继切片)。
pub mod atmosphere_sky;
pub mod studio_background;
mod half_float;
pub mod ground_preview;
pub mod asset_package;
pub mod author_grading;
pub mod output_color_profile;
pub mod behavior_extension;
pub mod behavior_ir;
pub mod bloom;
pub mod cascaded_shadow;
mod cascaded_shadow_math;
pub mod chart;
pub mod clustered_lighting;
pub mod compat_x;
pub mod contract;
pub mod culling_contract;
#[cfg(windows)]
pub mod dashboard_audio;
pub mod dashboard_runtime;
#[cfg(windows)]
pub mod dashboard_video;
pub mod deep2d;
pub mod executable_overlay;
pub mod fog;
/// J2-B7 frame ABI 单源生成常量（方案 C；schema-sha256 指纹门见 frame_layout_gate）。
pub mod frame_layout_generated;
#[cfg(test)]
mod frame_layout_gate;
#[cfg(test)]
/// B2 frame v8 双端逐字节 golden 对拍 native 侧(fixture 单源:
/// deep-engine/fixtures/frame-abi,TS twin 见 frameAbi/frameV8GoldenParity.test.ts)。
mod frame_v8_golden_parity_tests;
pub mod half_decode;
pub mod hardware_ray_query;
pub mod host_capabilities;
pub mod ibl;
pub mod ies_shading;
#[cfg(windows)]
pub mod industrial_worker_host;
/// J2-B1 灯光数学三件套 WGSL 单源的 Rust 消费端与双端校验和对拍(详见模块文档)。
pub mod lighting_math_wgsl;
pub mod local_lighting;
pub mod local_shadow;
pub mod lod_contract;
pub mod mesh_abi;
pub mod native_animation_controller;
/// T14 动画 clip 事件收集的 Native 同语义镜像
/// （TS 合同：`deep-engine/src/gltf/renderAnimationEvents.ts`）。
pub mod native_animation_events;
#[cfg(test)]
mod native_animation_events_tests;
/// T14 动画播放时钟的 Native 同语义镜像
/// （TS 合同：`deep-engine/src/gltf/renderAnimationPlaybackClock.ts`）。
pub mod native_animation_playback_clock;
/// T14 根运动增量记录的 Native 同语义镜像
/// （TS 合同：`deep-engine/src/gltf/renderAnimationRootMotion.ts`）。
pub mod native_animation_root_motion;
#[cfg(test)]
mod native_animation_root_motion_tests;
/// T16 角色运动状态机与固定步长推进。消费合同
/// `SceneCharacterControllerState`(Web 同语义:`apps/web/src/viewer/rapierCharacterController.ts`)
/// 与 T14 根运动增量(`native_animation_root_motion`),驱动 kinematic 角色刚体。
pub mod native_character_motion;
#[cfg(test)]
mod native_character_motion_tests;
pub mod native_physics;
pub mod physics_debug_compare;
pub mod physics_sdf_mesh;
pub mod native_ui;
pub mod pbr_brdf;
/// I-C23 分层材质:304B 层块打包 + 求值响应级凸混合 CPU 参考(Web 单源镜像)。
pub mod pbr_layered;

#[cfg(test)]
#[path = "pbr_layered_contract_tests.rs"]
mod pbr_layered_contract_tests;
/// C9/native 材质扩展带 CPU 权威镜像(f64;TS materialEvaluate/materialAdvancedReference
/// 同式移植 + native_extended_shade 合成腿),与 material_parity_tests 共同消费
/// fixtures 对拍;仅供测试与真机对拍,生产渲染不引用。
pub mod material_extended_cpu;

#[cfg(test)]
#[path = "material_parity_tests.rs"]
mod material_parity_tests;
pub mod pbr_reference;
pub mod pbr_texture;
pub mod platform_text;
pub mod player_view;
/// native 后处理域(与 web postprocess 域对应):spatial_aa = FXAA
/// (Three r185 逐式移植 + CPU 镜像,登记 supported/harness-only)。
pub mod postprocess;
pub mod probe_gi_abi;
/// F3 探针网格头合同与三线性采样 CPU 参考（与 WGSL 逐式对拍）。
pub mod probe_gi_grid;
/// F3 探针 storage/bind 合同。bin target 另在 main.rs 声明同名私有模块
/// (与 probe_gi_abi 同一源文件双编译模式),renderer 的 crate:: 引用走 bin 侧。
pub mod probe_gi_storage;
/// F5 WGSL 单源试点:探针 GI 采样库的 include_str! 消费端与双端校验和对拍(详见模块文档)。
pub mod probe_gi_wgsl;
pub mod native_mesh_wgsl;
mod native_material_source;
#[cfg(test)]
mod probe_gi_native_adapter_tests;
/// P1 质量主线(六引擎对标刀位 1):native SDF-GI 链——场景级 SDF 体积烘焙
/// (CPU 权威镜像,TS sdfSceneBake/sdfGrid 同构)+ 探针 lattice 推导。
/// `.dgc` 字节 → native 簇 LOD DAG 运行时构建(批 C):read_dgc 单源读取 →
/// 路 4 映射(dgcClusterLodBridge 同式)→ validateClusterLodDag 合同签核 →
/// 64B 节点表打包 + indirect 计划面(批 A/B 模块零转换消费)。
pub mod gpu_cluster_lod_dag;
pub mod gpu_cluster_lod_dag_tests;
pub mod gpu_cluster_lod_dag_probe_tests;
/// 批 C 渲染器接线运行时(六引擎对标 P1 收官件):DAG 三面产物 → GPU 驻留 buffer 族
/// (预检 fail-closed)+ 相机 uniform 打包 + 选层 dispatch(帧循环模式)+ faults 零门
/// → indirect 计划 → draw-indexed-indirect 命令字写入 + 渲染 pass 消费面
/// (encode_draws;详见模块文档,GpuLod attach 接入帧循环)。
pub mod gpu_cluster_lod_runtime;
pub mod gpu_cluster_lod_runtime_tests;
/// 批 C 运行时 GPU 探针(#[ignore] 真机门;golden 双臂端到端对拍 + 渲染消费)。
pub mod gpu_cluster_lod_runtime_gpu_probe;
/// 场景包 → .dgc 驻留摄入(场景级聚合;TS assetClusterLodIngest 对端:逐节 from_dgc
/// 单节链 + CPU 驻留预检 + 材质实例绑定记录;单节失败显式回退,合同违约整体 Err;
/// 逐节 GPU 驻留构造与 pass 调用点属后续切片)。
pub mod gpu_cluster_lod_scene;
pub mod gpu_cluster_lod_scene_tests;
pub mod gpu_cluster_lod_indirect;
pub mod gpu_cluster_lod_indirect_tests;
pub mod gpu_cluster_lod_gpu;
pub mod gpu_cluster_lod_gpu_probe_tests;
pub mod gpu_cluster_lod_selection;
pub mod gpu_cluster_lod_wgsl;
pub mod gpu_cluster_lod_selection_tests;
pub mod sdf_gi_scene;
pub mod sdf_gi_scene_compose;
/// 天光圆锥追踪(visibility+hitDistance 双输出)+ Fibonacci 方向集
/// (TS sdfSkyVisibility/probeOcclusionDirection 同构)。
pub mod sdf_gi_trace;
/// 探针 SH 更新链(L1 SH 投影/目标场/bounce 哨兵/时域滤波/命中统计归约/窗口计划;
/// TS probeShUpdate/probeSkyVisibilitySh/sdfGiPacking 同构;记录直供 probe_gi_abi)。
pub mod sdf_gi_probe_update;
/// sdf-gi 三个 WGSL 计算核的单源 include_str! 消费端与双端校验和对拍(补齐 Rust 半)。
pub mod sdf_gi_wgsl;
/// P1 质量主线(六引擎对标刀位 2):MegaLights 灯池 64B ABI 与统一灯光结构
/// (TS megaLights.ts/megaLightsAbi.ts 互钉;打包与词流指纹)。
pub mod megalights_abi;
/// MegaLights IES 因子注入(2026-10-06 后继切片 1):E02 打包载荷评测端
/// (TS iesShading.evaluateIesShadingFactor 同式;64B 灯池字 11 = 行号+1)。
pub mod megalights_ies;
/// MegaLights 胜者可见性射线档(2026-10-06 后继切片 2):两级 TLAS 遮挡
/// (traceTwoLevelOccluded 同族,复用 ray_backend)+ 胜者射线构建 + fail-closed。
pub mod megalights_visibility;
/// P1 质量主线(六引擎对标刀位 2):native MegaLights 万灯直接光 RIS 的 CPU 权威镜像
/// (RIS 蓄水池+时域/空间值域复用+胜者可见性+穷举参考+直射通路选择;
/// TS megaLightsRisCpu.ts 同构)。
pub mod megalights_ris;
#[cfg(test)]
#[path = "megalights_ris_tests.rs"]
mod megalights_ris_tests;
/// MegaLights RIS WGSL 单源 include_str! 消费端与双端校验和对拍(Rust 半;
/// TS 半 = megaLightsRisWgslChecksum.test.ts)。
pub mod megalights_wgsl;
#[cfg(test)]
#[path = "megalights_parity_tests.rs"]
mod megalights_parity_tests;
#[cfg(test)]
#[path = "megalights_gpu_probe_tests.rs"]
mod megalights_gpu_probe_tests;
#[cfg(test)]
#[path = "sdf_gi_parity_tests.rs"]
mod sdf_gi_parity_tests;
#[cfg(test)]
#[path = "sdf_gi_gpu_probe_tests.rs"]
mod sdf_gi_gpu_probe_tests;
pub mod ray_backend;
pub mod ray_tracing_capability;
pub mod replay;
/// J4 能力协商:native 端渲染能力自检声明(金样来自 contracts/fixtures,见模块文档)。
pub mod renderer_capability_manifest;
pub mod runtime_camera;
pub mod runtime_coordinates;
pub mod runtime_navigation;
/// T19 多代理人群导航：SoA 紧凑状态、分批调度、固定步长与显式排队避障。
pub mod runtime_navigation_crowd;
#[cfg(test)]
mod runtime_navigation_tests;

pub mod runtime_package;
pub mod scene;
mod scene_alpha;
pub mod scene_bounds;
pub mod scene_lighting;
mod scene_pack;
pub mod scene_resource_domain;
pub mod scene_resource_identity;
pub mod shader_disk_cache;
pub mod shader_package;
pub mod shadow_cache;
pub mod texture_array_packing;
/// J2-B3 白炉验收核心:CPU 参考判据移植(whiteFurnace.ts)+ IBL split-sum 修复对拍。
pub mod white_furnace;
pub mod world_chunk_bridge;
pub mod world_partition;

pub const NATIVE_SHADER_VERSION: u32 = 1;
