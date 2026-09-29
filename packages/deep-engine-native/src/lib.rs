pub mod adapter_n1;
pub mod asset_package;
pub mod author_grading;
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
pub mod physics_sdf_mesh;
pub mod native_ui;
pub mod pbr_brdf;
pub mod pbr_reference;
pub mod pbr_texture;
pub mod platform_text;
pub mod player_view;
pub mod probe_gi_abi;
/// F3 探针网格头合同与三线性采样 CPU 参考（与 WGSL 逐式对拍）。
pub mod probe_gi_grid;
/// F3 探针 storage/bind 合同。bin target 另在 main.rs 声明同名私有模块
/// (与 probe_gi_abi 同一源文件双编译模式),renderer 的 crate:: 引用走 bin 侧。
pub mod probe_gi_storage;
/// F5 WGSL 单源试点:探针 GI 采样库的 include_str! 消费端与双端校验和对拍(详见模块文档)。
pub mod probe_gi_wgsl;
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
