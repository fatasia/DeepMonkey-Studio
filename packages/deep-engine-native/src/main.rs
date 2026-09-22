#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod app;
mod app_startup;
mod asset_package_cli;
mod bloom_pass;
mod bloom_pipeline;
#[cfg(test)]
mod chart_gpu_tests;
mod cli;
mod cli_viewer_tools;
#[cfg(windows)]
mod dashboard_video_gpu;
mod deep2d_atlas_gpu;
#[cfg(test)]
mod deep2d_clip_gpu_tests;
#[cfg(test)]
mod deep2d_context_wiring_tests;
mod deep2d_gpu;
mod deep2d_gpu_cache;
#[cfg(test)]
mod deep2d_gpu_cache_tests;
mod deep2d_interleave_probe;
#[cfg(test)]
mod deep2d_path_clip_gpu_tests;
mod deep2d_scissor;
#[cfg(test)]
mod deep2d_text_gpu_tests;
#[cfg(test)]
mod dpi_matrix_gpu_tests;
mod events;
#[cfg(test)]
mod filter_glyph_gpu_tests;
mod fog_cli;
mod forward_targets;
mod frame_bindings;
mod gpu_context;
mod gpu_culling;
mod gpu_culling_readback;
mod gpu_culling_resources;
mod gpu_ibl;
mod gpu_lod;
mod gpu_lod_resources;
mod gpu_lod_views;
mod gpu_occlusion;
mod gpu_occlusion_consume;
#[cfg(test)]
mod gpu_occlusion_consume_tests;
#[cfg(test)]
mod gpu_occlusion_tests;
mod gpu_resources;
mod gpu_scene;
mod gpu_scene_cache;
mod gpu_scene_cache_instances;
mod gpu_scene_cache_refresh;
#[cfg(test)]
mod gpu_scene_cache_refresh_tests;
#[cfg(test)]
mod gpu_scene_cache_revision_tests;
mod gpu_scene_cache_stage;
#[cfg(test)]
mod gpu_scene_cache_test_support;
#[cfg(test)]
mod gpu_scene_cache_tests;
mod gpu_scene_draw;
mod gpu_shader_materials;
mod gpu_submission;
mod gpu_texture_types;
mod gpu_texture_upload;
mod gpu_textures;
mod half_float;
mod hdr_prefilter_cli;
mod hdr_readback;
mod ibl_probe;
mod mesh_pass;
#[cfg(test)]
mod million_point_gpu_tests;
mod outline_pass;
mod output_pass;
mod pipeline;
mod player_annotations;
mod player_cli;
mod player_content;
mod player_diagnostics;
mod player_measurement;
mod player_picking;
mod player_shader_plan;
mod player_state;
// F3 GI storage 的 bin 侧依赖:probe_gi_abi 与 lib 共用同一源文件,
// 缺此声明时 bin target 编译失败(probe_gi_storage 的 crate:: 引用无法解析)。
mod probe_gi_abi;
mod probe_gi_storage;
#[cfg(test)]
mod prototype_gpu_tests;
mod publication_verification;
mod render_graph;
#[cfg(test)]
mod render_graph_tests;
mod renderer;
mod runtime_lkg;
mod runtime_package_startup;
mod shader_package_probe;
mod shader_package_probe_draw;
mod shader_package_probe_resources;
mod shadow_dirty;
#[cfg(test)]
mod shadow_fit_gpu_tests;
mod shadow_map;
mod shadow_map_update;
mod shadow_pass;
mod shadow_probe;
mod shadow_update_classify;
mod telemetry;
mod telemetry_gpu;
mod text_raster_cli;
mod texture_array_bindings;
mod window_chrome;
#[cfg(windows)]
mod x_package_source;
mod x_package_window;
mod x_worker_cli;

fn main() {
    if let Err(error) = cli::execute() {
        eprintln!("deep-engine-native: {error}");
        std::process::exit(1);
    }
}
