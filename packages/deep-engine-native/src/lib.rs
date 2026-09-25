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
pub mod local_lighting;
pub mod local_shadow;
pub mod lod_contract;
pub mod mesh_abi;
pub mod native_animation_controller;
pub mod native_physics;
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
pub mod ray_backend;
pub mod ray_tracing_capability;
pub mod replay;
pub mod runtime_camera;
pub mod runtime_coordinates;
pub mod runtime_navigation;
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
pub mod world_chunk_bridge;
pub mod world_partition;

pub const NATIVE_SHADER_VERSION: u32 = 1;
