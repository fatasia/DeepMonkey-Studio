pub mod adapter_n1;
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
#[cfg(test)]
mod probe_gi_native_adapter_tests;
/// P1 质量主线(六引擎对标刀位 1):native SDF-GI 链——场景级 SDF 体积烘焙
/// (CPU 权威镜像,TS sdfSceneBake/sdfGrid 同构)+ 探针 lattice 推导。
pub mod sdf_gi_scene;
/// 天光圆锥追踪(visibility+hitDistance 双输出)+ Fibonacci 方向集
/// (TS sdfSkyVisibility/probeOcclusionDirection 同构)。
pub mod sdf_gi_trace;
/// 探针 SH 更新链(L1 SH 投影/目标场/bounce 哨兵/时域滤波/命中统计归约/窗口计划;
/// TS probeShUpdate/probeSkyVisibilitySh/sdfGiPacking 同构;记录直供 probe_gi_abi)。
pub mod sdf_gi_probe_update;
/// sdf-gi 三个 WGSL 计算核的单源 include_str! 消费端与双端校验和对拍(补齐 Rust 半)。
pub mod sdf_gi_wgsl;
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
