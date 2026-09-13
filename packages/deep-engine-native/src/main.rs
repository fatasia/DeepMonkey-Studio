mod app;
mod app_startup;
mod bloom_pass;
mod bloom_pipeline;
mod cli;
mod deep2d_atlas_gpu;
mod deep2d_gpu;
mod deep2d_interleave_probe;
mod events;
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
mod gpu_resources;
mod gpu_scene;
mod gpu_scene_cache;
mod gpu_scene_cache_instances;
mod gpu_scene_cache_stage;
#[cfg(test)]
mod gpu_scene_cache_tests;
mod gpu_scene_draw;
mod gpu_shader_materials;
mod gpu_submission;
mod gpu_texture_types;
mod gpu_texture_upload;
mod gpu_textures;
mod half_float;
mod hdr_readback;
mod ibl_probe;
mod mesh_pass;
mod output_pass;
mod pipeline;
mod player_cli;
mod player_content;
mod player_shader_plan;
mod player_state;
mod renderer;
mod shader_package_probe;
mod shader_package_probe_draw;
mod shader_package_probe_resources;
#[cfg(test)]
mod shadow_fit_gpu_tests;
mod shadow_map;
mod shadow_map_update;
mod shadow_pass;
mod shadow_probe;

fn main() {
    if let Err(error) = cli::execute() {
        eprintln!("deep-engine-native: {error}");
        std::process::exit(1);
    }
}
