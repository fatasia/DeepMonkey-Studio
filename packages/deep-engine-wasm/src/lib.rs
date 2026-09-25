//! DeepMonkey wasm:全引擎镜像集成 + 三方案对比 bench viewer。
//! 镜像模块必须位于 crate 根(bin 树的 crate::app 等路径依赖此布局)。

use wasm_bindgen::prelude::*;

thread_local! {
    static SCENE_PACKAGE: std::cell::RefCell<Option<Vec<u8>>> = const { std::cell::RefCell::new(None) };
    static VIEWER_SESSIONS: std::cell::RefCell<std::collections::BTreeMap<u32, winit::event_loop::EventLoopProxy<events::GpuEvent>>> = const { std::cell::RefCell::new(std::collections::BTreeMap::new()) };
    static NEXT_VIEWER_SESSION: std::cell::Cell<u32> = const { std::cell::Cell::new(1) };
}

#[wasm_bindgen]
pub fn set_scene_package(bytes: &[u8]) -> Result<(), JsValue> {
    deep_engine_native::runtime_package::parse_and_validate_runtime_package(bytes)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    SCENE_PACKAGE.with(|slot| *slot.borrow_mut() = Some(bytes.to_vec()));
    Ok(())
}

/// Reset the browser-hosted font bundle before injecting a new locale/font set.
#[wasm_bindgen]
pub fn clear_runtime_fonts() {
    deep_engine_native::platform_text::clear_runtime_fonts();
}

/// Supply one exact font face from JavaScript. SHA-256, face index, byte/count
/// budgets and selector ambiguity are validated before the bundle is published.
#[wasm_bindgen]
pub fn add_runtime_font(
    locale: String,
    bytes: &[u8],
    sha256: String,
    face_index: u32,
) -> Result<u32, JsValue> {
    let font = deep_engine_native::platform_text::FrozenFontInput {
        bytes: bytes.to_vec(),
        sha256,
        face_index,
    };
    deep_engine_native::platform_text::add_runtime_font(&locale, font)
        .and_then(|count| u32::try_from(count).map_err(|_| "runtime font count overflow".into()))
        .map_err(|error| JsValue::from_str(&error))
}

#[wasm_bindgen]
pub fn start_scene_viewer(canvas: Option<web_sys::HtmlCanvasElement>) -> Result<u32, JsValue> {
    console_error_panic_hook::set_once();
    let bytes = SCENE_PACKAGE
        .with(|slot| slot.borrow().clone())
        .ok_or_else(|| JsValue::from_str("scene package bytes were not injected"))?;
    let package =
        runtime_package_startup::load_bytes(&bytes).map_err(|error| JsValue::from_str(&error))?;
    app_startup::set_wasm_canvas(canvas);
    let proxy =
        app::spawn_wasm(package.into_content()).map_err(|error| JsValue::from_str(&error))?;
    let handle = NEXT_VIEWER_SESSION.with(|next| {
        let handle = next.get();
        next.set(handle.checked_add(1).unwrap_or(1));
        handle
    });
    VIEWER_SESSIONS.with(|sessions| {
        sessions.borrow_mut().insert(handle, proxy);
    });
    Ok(handle)
}

#[wasm_bindgen]
pub fn stop_scene_viewer(handle: u32) {
    let proxy = VIEWER_SESSIONS.with(|sessions| sessions.borrow_mut().remove(&handle));
    if let Some(proxy) = proxy {
        let _ = proxy.send_event(events::GpuEvent::WasmStop);
    }
}

#[wasm_bindgen]
pub fn update_scene_viewer(handle: u32, bytes: &[u8]) -> Result<(), JsValue> {
    deep_engine_native::runtime_package::parse_and_validate_runtime_package(bytes)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let proxy = VIEWER_SESSIONS
        .with(|sessions| sessions.borrow().get(&handle).cloned())
        .ok_or_else(|| JsValue::from_str("scene viewer handle is not active"))?;
    proxy
        .send_event(events::GpuEvent::WasmScenePackage(bytes.to_vec()))
        .map_err(|_| JsValue::from_str("scene viewer event loop is closed"))
}

#[wasm_bindgen]
pub fn update_editor_overlay(handle: u32, revision: u32, vertices: &[f32]) -> Result<(), JsValue> {
    if vertices.len() % 24 != 0 || vertices.len() > 196_608 * 8 {
        return Err(JsValue::from_str("WASM editor overlay layout or vertex budget is invalid"));
    }
    let proxy = VIEWER_SESSIONS
        .with(|sessions| sessions.borrow().get(&handle).cloned())
        .ok_or_else(|| JsValue::from_str("scene viewer handle is not active"))?;
    proxy.send_event(events::GpuEvent::WasmEditorOverlay {
        revision: u64::from(revision),
        vertices: vertices.to_vec(),
    }).map_err(|_| JsValue::from_str("scene viewer event loop is closed"))
}

#[wasm_bindgen]
pub fn set_viewer_camera(
    handle: u32,
    position_x: f32,
    position_y: f32,
    position_z: f32,
    target_x: f32,
    target_y: f32,
    target_z: f32,
    focal: f32,
    near: f32,
    far: f32,
) -> Result<(), JsValue> {
    let proxy = VIEWER_SESSIONS
        .with(|sessions| sessions.borrow().get(&handle).cloned())
        .ok_or_else(|| JsValue::from_str("scene viewer handle is not active"))?;
    proxy
        .send_event(events::GpuEvent::WasmCamera {
            position: [position_x, position_y, position_z],
            target: [target_x, target_y, target_z],
            focal,
            near,
            far,
        })
        .map_err(|_| JsValue::from_str("scene viewer event loop is closed"))
}

#[wasm_bindgen]
pub fn viewer_ready_generation() -> u32 {
    app_startup::wasm_renderer_ready_generation()
}

#[wasm_bindgen]
pub fn viewer_failure_message() -> Option<String> {
    app_startup::wasm_renderer_failure()
}

#[wasm_bindgen]
pub fn engine_canvas(_handle: u32) -> Option<web_sys::HtmlCanvasElement> {
    app_startup::wasm_window_canvas()
}

#[path = "../../deep-engine-native/src/app/mod.rs"]
pub mod app;

#[path = "../../deep-engine-native/src/app_startup.rs"]
pub mod app_startup;

#[path = "../../deep-engine-native/src/asset_package_cli.rs"]
pub mod asset_package_cli;

#[path = "../../deep-engine-native/src/bloom_pass.rs"]
pub mod bloom_pass;

#[path = "../../deep-engine-native/src/bloom_pipeline.rs"]
pub mod bloom_pipeline;

#[cfg(test)]
#[path = "../../deep-engine-native/src/chart_gpu_tests.rs"]
pub mod chart_gpu_tests;

#[path = "../../deep-engine-native/src/cli.rs"]
pub mod cli;

#[path = "../../deep-engine-native/src/cli_viewer_tools.rs"]
pub mod cli_viewer_tools;

#[cfg(windows)]
#[path = "../../deep-engine-native/src/dashboard_video_gpu.rs"]
pub mod dashboard_video_gpu;

#[path = "../../deep-engine-native/src/deep2d_atlas_gpu.rs"]
pub mod deep2d_atlas_gpu;

#[cfg(test)]
#[path = "../../deep-engine-native/src/deep2d_clip_gpu_tests.rs"]
pub mod deep2d_clip_gpu_tests;

#[cfg(test)]
#[path = "../../deep-engine-native/src/deep2d_context_wiring_tests.rs"]
pub mod deep2d_context_wiring_tests;

#[path = "../../deep-engine-native/src/deep2d_gpu.rs"]
pub mod deep2d_gpu;

#[path = "../../deep-engine-native/src/deep2d_gpu_cache.rs"]
pub mod deep2d_gpu_cache;

#[cfg(test)]
#[path = "../../deep-engine-native/src/deep2d_gpu_cache_tests.rs"]
pub mod deep2d_gpu_cache_tests;

#[path = "../../deep-engine-native/src/deep2d_interleave_probe.rs"]
pub mod deep2d_interleave_probe;

#[cfg(test)]
#[path = "../../deep-engine-native/src/deep2d_path_clip_gpu_tests.rs"]
pub mod deep2d_path_clip_gpu_tests;

#[path = "../../deep-engine-native/src/deep2d_scissor.rs"]
pub mod deep2d_scissor;

#[cfg(test)]
#[path = "../../deep-engine-native/src/deep2d_text_gpu_tests.rs"]
pub mod deep2d_text_gpu_tests;

#[cfg(test)]
#[path = "../../deep-engine-native/src/dpi_matrix_gpu_tests.rs"]
pub mod dpi_matrix_gpu_tests;

#[path = "../../deep-engine-native/src/events.rs"]
pub mod events;

#[cfg(test)]
#[path = "../../deep-engine-native/src/filter_glyph_gpu_tests.rs"]
pub mod filter_glyph_gpu_tests;

#[path = "../../deep-engine-native/src/fog_cli.rs"]
pub mod fog_cli;

#[path = "../../deep-engine-native/src/forward_targets.rs"]
pub mod forward_targets;

#[path = "../../deep-engine-native/src/frame_bindings.rs"]
pub mod frame_bindings;

#[path = "../../deep-engine-native/src/gpu_context.rs"]
pub mod gpu_context;

#[path = "../../deep-engine-native/src/gpu_culling.rs"]
pub mod gpu_culling;

#[path = "../../deep-engine-native/src/gpu_culling_readback.rs"]
pub mod gpu_culling_readback;

#[path = "../../deep-engine-native/src/gpu_culling_resources.rs"]
pub mod gpu_culling_resources;

#[path = "../../deep-engine-native/src/gpu_ibl.rs"]
pub mod gpu_ibl;

#[path = "../../deep-engine-native/src/gpu_lod.rs"]
pub mod gpu_lod;

#[path = "../../deep-engine-native/src/gpu_lod_resources.rs"]
pub mod gpu_lod_resources;

#[path = "../../deep-engine-native/src/gpu_lod_views.rs"]
pub mod gpu_lod_views;

#[path = "../../deep-engine-native/src/gpu_occlusion.rs"]
pub mod gpu_occlusion;

#[path = "../../deep-engine-native/src/gpu_occlusion_consume.rs"]
pub mod gpu_occlusion_consume;

#[cfg(test)]
#[path = "../../deep-engine-native/src/gpu_occlusion_consume_tests.rs"]
pub mod gpu_occlusion_consume_tests;

#[cfg(test)]
#[path = "../../deep-engine-native/src/gpu_occlusion_tests.rs"]
pub mod gpu_occlusion_tests;

#[path = "../../deep-engine-native/src/gpu_resources.rs"]
pub mod gpu_resources;

#[path = "../../deep-engine-native/src/gpu_scene.rs"]
pub mod gpu_scene;

#[path = "../../deep-engine-native/src/gpu_scene_cache.rs"]
pub mod gpu_scene_cache;

#[path = "../../deep-engine-native/src/gpu_scene_cache_instances.rs"]
pub mod gpu_scene_cache_instances;

#[path = "../../deep-engine-native/src/gpu_scene_cache_refresh.rs"]
pub mod gpu_scene_cache_refresh;

#[cfg(test)]
#[path = "../../deep-engine-native/src/gpu_scene_cache_refresh_tests.rs"]
pub mod gpu_scene_cache_refresh_tests;

#[cfg(test)]
#[path = "../../deep-engine-native/src/gpu_scene_cache_revision_tests.rs"]
pub mod gpu_scene_cache_revision_tests;

#[path = "../../deep-engine-native/src/gpu_scene_cache_stage.rs"]
pub mod gpu_scene_cache_stage;

#[cfg(test)]
#[path = "../../deep-engine-native/src/gpu_scene_cache_test_support.rs"]
pub mod gpu_scene_cache_test_support;

#[cfg(test)]
#[path = "../../deep-engine-native/src/gpu_scene_cache_tests.rs"]
pub mod gpu_scene_cache_tests;

#[path = "../../deep-engine-native/src/gpu_scene_draw.rs"]
pub mod gpu_scene_draw;

#[path = "../../deep-engine-native/src/gpu_shader_materials.rs"]
pub mod gpu_shader_materials;

#[path = "../../deep-engine-native/src/gpu_submission.rs"]
pub mod gpu_submission;

#[path = "../../deep-engine-native/src/gpu_texture_types.rs"]
pub mod gpu_texture_types;

#[path = "../../deep-engine-native/src/gpu_texture_upload.rs"]
pub mod gpu_texture_upload;

#[path = "../../deep-engine-native/src/gpu_textures.rs"]
pub mod gpu_textures;

#[path = "../../deep-engine-native/src/half_float.rs"]
pub mod half_float;

#[path = "../../deep-engine-native/src/hdr_prefilter_cli.rs"]
pub mod hdr_prefilter_cli;

#[path = "../../deep-engine-native/src/hdr_readback.rs"]
pub mod hdr_readback;

#[path = "../../deep-engine-native/src/ibl_probe.rs"]
pub mod ibl_probe;

#[path = "../../deep-engine-native/src/mesh_pass.rs"]
pub mod mesh_pass;

#[cfg(test)]
#[path = "../../deep-engine-native/src/million_point_gpu_tests.rs"]
pub mod million_point_gpu_tests;

#[path = "../../deep-engine-native/src/outline_pass.rs"]
pub mod outline_pass;

#[path = "../../deep-engine-native/src/output_pass.rs"]
pub mod output_pass;

#[path = "../../deep-engine-native/src/pipeline/mod.rs"]
pub mod pipeline;

#[path = "../../deep-engine-native/src/player_annotations.rs"]
pub mod player_annotations;

#[path = "../../deep-engine-native/src/player_cli.rs"]
pub mod player_cli;

#[path = "../../deep-engine-native/src/player_content.rs"]
pub mod player_content;

#[path = "../../deep-engine-native/src/player_diagnostics/mod.rs"]
pub mod player_diagnostics;

#[path = "../../deep-engine-native/src/player_measurement.rs"]
pub mod player_measurement;

#[path = "../../deep-engine-native/src/player_picking.rs"]
pub mod player_picking;

#[path = "../../deep-engine-native/src/player_shader_plan.rs"]
pub mod player_shader_plan;

#[path = "../../deep-engine-native/src/player_state.rs"]
pub mod player_state;

#[path = "../../deep-engine-native/src/probe_gi_abi.rs"]
pub mod probe_gi_abi;

#[path = "../../deep-engine-native/src/probe_gi_storage.rs"]
pub mod probe_gi_storage;

#[path = "../../deep-engine-native/src/probe_gi_grid.rs"]
pub mod probe_gi_grid;

#[cfg(test)]
#[path = "../../deep-engine-native/src/prototype_gpu_tests.rs"]
pub mod prototype_gpu_tests;

#[path = "../../deep-engine-native/src/publication_record.rs"]
pub mod publication_record;

#[path = "../../deep-engine-native/src/publication_verification.rs"]
pub mod publication_verification;

#[path = "../../deep-engine-native/src/render_graph.rs"]
pub mod render_graph;

#[cfg(test)]
#[path = "../../deep-engine-native/src/render_graph_tests.rs"]
pub mod render_graph_tests;

#[path = "../../deep-engine-native/src/renderer/mod.rs"]
pub mod renderer;

#[path = "../../deep-engine-native/src/runtime_lkg.rs"]
pub mod runtime_lkg;

#[path = "../../deep-engine-native/src/runtime_package_startup.rs"]
pub mod runtime_package_startup;

#[path = "../../deep-engine-native/src/shader_package_probe.rs"]
pub mod shader_package_probe;

#[path = "../../deep-engine-native/src/shader_package_probe_draw.rs"]
pub mod shader_package_probe_draw;

#[path = "../../deep-engine-native/src/shader_package_probe_resources.rs"]
pub mod shader_package_probe_resources;

#[path = "../../deep-engine-native/src/shadow_dirty.rs"]
pub mod shadow_dirty;

#[cfg(test)]
#[path = "../../deep-engine-native/src/shadow_fit_gpu_tests.rs"]
pub mod shadow_fit_gpu_tests;

#[path = "../../deep-engine-native/src/shadow_map/mod.rs"]
pub mod shadow_map;

#[path = "../../deep-engine-native/src/shadow_map_update.rs"]
pub mod shadow_map_update;

#[path = "../../deep-engine-native/src/shadow_pass.rs"]
pub mod shadow_pass;

#[path = "../../deep-engine-native/src/shadow_probe.rs"]
pub mod shadow_probe;

#[path = "../../deep-engine-native/src/shadow_update_classify/mod.rs"]
pub mod shadow_update_classify;

#[path = "../../deep-engine-native/src/telemetry.rs"]
pub mod telemetry;

#[path = "../../deep-engine-native/src/telemetry_gpu.rs"]
pub mod telemetry_gpu;

#[path = "../../deep-engine-native/src/text_raster_cli.rs"]
pub mod text_raster_cli;

#[path = "../../deep-engine-native/src/texture_array_bindings.rs"]
pub mod texture_array_bindings;

#[path = "../../deep-engine-native/src/window_chrome.rs"]
pub mod window_chrome;

#[cfg(windows)]
#[path = "../../deep-engine-native/src/x_package_source.rs"]
pub mod x_package_source;

#[path = "../../deep-engine-native/src/x_package_window.rs"]
pub mod x_package_window;

#[path = "../../deep-engine-native/src/x_worker_cli.rs"]
pub mod x_worker_cli;

#[cfg(feature = "bench-viewer")]
pub mod bench {
    //! DeepMonkey 引擎核心 wasm 首片:WebGPU 后端 instanced PBR 渲染器。
    //! 目标是三方案对比(Three WebGL / 自研 TS WebGPU / Rust wasm)中第三条的
    //! 体积与性能实测基线;完整播放器 wasm 化(52 处 block_on 消除、执行器线程池
    //! wasm-threads 改造、媒体栈)是独立后续工程,不在这首片承诺内。

    use wasm_bindgen::prelude::*;
    use wgpu::util::DeviceExt;

    const INSTANCE_COUNT: u32 = 5000;

    #[repr(C)]
    #[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
    struct InstanceData {
        position: [f32; 3],
        scale: f32,
        color: [f32; 3],
        kind: f32,
    }

    #[repr(C)]
    #[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
    struct Uniforms {
        view_proj: [[f32; 4]; 4],
        time: f32,
        pad: [f32; 7],
    }

    const WGSL: &str = r#"
    struct Uniforms {
        view_proj: mat4x4<f32>,
        time: f32,
        pad: vec3<f32>,
    };
    @group(0) @binding(0) var<uniform> u: Uniforms;

    struct VSOut {
        @builtin(position) clip: vec4<f32>,
        @location(0) normal: vec3<f32>,
        @location(1) color: vec3<f32>,
        @location(2) world: vec3<f32>,
    };

    @vertex
    fn vs_debug(@builtin(vertex_index) vi: u32) -> VSOut {
        var pts = array(vec3<f32>(-1.0, -1.0, 0.2), vec3<f32>(3.0, -1.0, 0.2), vec3<f32>(-1.0, 3.0, 0.2));
        var out: VSOut;
        out.clip = vec4<f32>(pts[vi], 1.0);
        out.normal = vec3<f32>(0.0, 0.0, 1.0);
        out.color = vec3<f32>(0.95, 0.3, 0.25);
        out.world = vec3<f32>(0.0);
        return out;
    }

    @vertex
    fn vs_main(
        @location(0) pos: vec3<f32>,
        @location(1) nrm: vec3<f32>,
        @location(2) inst_pos: vec3<f32>,
        @location(3) inst_scale: f32,
        @location(4) inst_color: vec3<f32>,
        @location(5) inst_kind: f32,
    ) -> VSOut {
        let spin = u.time * (0.2 + inst_kind * 0.15);
        let c = cos(spin); let s = sin(spin);
        let p = pos * inst_scale;
        let rotated = vec3<f32>(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
        let world = rotated + inst_pos + vec3<f32>(0.0, sin(u.time * 0.8 + inst_pos.x * 0.35 + inst_pos.z * 0.21) * 0.12, 0.0);
        let n = vec3<f32>(nrm.x * c - nrm.z * s, nrm.y, nrm.x * s + nrm.z * c);
        var out: VSOut;
        out.clip = u.view_proj * vec4<f32>(world, 1.0);
        out.normal = n;
        out.color = inst_color;
        out.world = world;
        return out;
    }

    @fragment
    fn fs_main(
        @location(0) normal: vec3<f32>,
        @location(1) color: vec3<f32>,
        @location(2) world: vec3<f32>,
    ) -> @location(0) vec4<f32> {
        let light_dir = normalize(vec3<f32>(0.45, 0.85, 0.35));
        let view_dir = normalize(vec3<f32>(0.0, 0.9, 2.6) - world);
        let n = normalize(normal);
        let diffuse = max(dot(n, light_dir), 0.0);
        let half_dir = normalize(light_dir + view_dir);
        let specular = pow(max(dot(n, half_dir), 0.0), 48.0) * 0.55;
        let rim = pow(1.0 - max(dot(n, view_dir), 0.0), 3.0) * 0.18;
        let ambient = vec3<f32>(0.16, 0.19, 0.22);
        let lit = ambient + color * (diffuse * 0.95 + vec3<f32>(specular) + vec3<f32>(rim));
        return vec4<f32>(lit, 1.0);
    }
    "#;

    fn unit_cube() -> (Vec<[f32; 3]>, Vec<[f32; 3]>, Vec<u32>) {
        let positions: Vec<[f32; 3]> = vec![
            [-0.5, -0.5, 0.5],
            [0.5, -0.5, 0.5],
            [0.5, 0.5, 0.5],
            [-0.5, 0.5, 0.5],
            [-0.5, -0.5, -0.5],
            [0.5, -0.5, -0.5],
            [0.5, 0.5, -0.5],
            [-0.5, 0.5, -0.5],
        ];
        let normals: Vec<[f32; 3]> = vec![
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
            [0.0, 0.0, -1.0],
            [0.0, 0.0, -1.0],
            [0.0, 0.0, -1.0],
        ];
        let indices: Vec<u32> = vec![
            0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 3, 2, 6, 3, 6, 7, 1, 5, 6, 1, 6, 2, 0, 4, 5, 0, 5,
            1, 0, 3, 7, 0, 7, 4,
        ];
        (positions, normals, indices)
    }

    fn view_projection(aspect: f32, time: f32) -> [[f32; 4]; 4] {
        let eye = [
            time.sin() * 2.4,
            1.5 + time.sin() * 0.3,
            2.6 + time.cos() * 0.4,
        ];
        let center = [0.0_f32, 0.2, 0.0];
        let up = [0.0_f32, 1.0, 0.0];
        let z: [f32; 3] = [eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]];
        let zl = (z[0] * z[0] + z[1] * z[1] + z[2] * z[2]).sqrt();
        let z = [z[0] / zl, z[1] / zl, z[2] / zl];
        let x = [
            up[1] * z[2] - up[2] * z[1],
            up[2] * z[0] - up[0] * z[2],
            up[0] * z[1] - up[1] * z[0],
        ];
        let xl = (x[0] * x[0] + x[1] * x[1] + x[2] * x[2]).sqrt();
        let x = [x[0] / xl, x[1] / xl, x[2] / xl];
        let y = [
            z[1] * x[2] - z[2] * x[1],
            z[2] * x[0] - z[0] * x[2],
            z[0] * x[1] - z[1] * x[0],
        ];
        let view = [
            [x[0], y[0], z[0], 0.0],
            [x[1], y[1], z[1], 0.0],
            [x[2], y[2], z[2], 0.0],
            [
                -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
                -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
                -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]),
                1.0,
            ],
        ];
        let f = 1.0 / (0.5 * 1.2_f32).tan();
        let near = 0.1_f32;
        let far = 60.0_f32;
        let proj = [
            [f / aspect, 0.0, 0.0, 0.0],
            [0.0, f, 0.0, 0.0],
            [0.0, 0.0, (far + near) / (near - far), -1.0],
            [0.0, 0.0, 2.0 * far * near / (near - far), 0.0],
        ];
        let mut out = [[0.0_f32; 4]; 4];
        for (r, vr) in view.iter().enumerate() {
            for c in 0..4 {
                out[r][c] = proj[r][0] * view[c][0]
                    + proj[r][1] * view[c][1]
                    + proj[r][2] * view[c][2]
                    + proj[r][3] * view[c][3];
            }
        }
        out
    }

    struct Gpu {
        device: wgpu::Device,
        queue: wgpu::Queue,
        surface: wgpu::Surface<'static>,
        pipeline: wgpu::RenderPipeline,
        mesh_pos: wgpu::Buffer,
        mesh_nrm: wgpu::Buffer,
        indices: wgpu::Buffer,
        index_count: u32,
        instances: wgpu::Buffer,
        uniforms: wgpu::Buffer,
        bind: wgpu::BindGroup,
        depth: Option<wgpu::TextureView>,
        size: (u32, u32),
        format: wgpu::TextureFormat,
    }

    fn instance_data() -> Vec<InstanceData> {
        let mut instances = Vec::with_capacity(INSTANCE_COUNT as usize);
        let side = (INSTANCE_COUNT as f32).cbrt().ceil() as u32;
        for i in 0..INSTANCE_COUNT {
            let gx = i % side;
            let gz = (i / side) % side;
            let gy = i / (side * side);
            instances.push(InstanceData {
                position: [
                    (gx as f32 - side as f32 / 2.0) * 0.32,
                    (gy as f32 - side as f32 / 2.0) * 0.32,
                    (gz as f32 - side as f32 / 2.0) * 0.32,
                ],
                scale: 0.09 + (i % 7) as f32 * 0.008,
                color: [
                    0.25 + (i % 5) as f32 * 0.11,
                    0.55 + (gz % 5) as f32 * 0.08,
                    0.65 + (gx % 5) as f32 * 0.07,
                ],
                kind: (i % 11) as f32,
            });
        }
        instances
    }

    #[wasm_bindgen]
    pub struct Viewer {
        gpu: Option<Gpu>,
    }

    #[wasm_bindgen]
    impl Viewer {
        /// 创建渲染器;浏览器 WebGPU 初始化是异步的,完成后用 render_frame 出帧。
        #[wasm_bindgen(constructor)]
        pub async fn new(canvas: web_sys::HtmlCanvasElement) -> Result<Viewer, JsValue> {
            console_error_panic_hook::set_once();
            let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
            descriptor.backends = wgpu::Backends::BROWSER_WEBGPU;
            let instance = wgpu::Instance::new(descriptor);
            let surface = instance
                .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
                .map_err(|e| JsValue::from_str(&format!("surface: {e}")))?;
            let adapter = instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::HighPerformance,
                    compatible_surface: Some(&surface),
                    force_fallback_adapter: false,
                    apply_limit_buckets: false,
                })
                .await
                .map_err(|e| JsValue::from_str(&format!("no adapter: {e}")))?;
            let (device, queue) = adapter
                .request_device(&wgpu::DeviceDescriptor::default())
                .await
                .map_err(|e| JsValue::from_str(&format!("device: {e}")))?;
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("deep-wasm-pbr"),
                source: wgpu::ShaderSource::Wgsl(WGSL.into()),
            });
            let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: None,
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                }],
            });
            let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: None,
                bind_group_layouts: &[Some(&bind_layout)],
                immediate_size: 0,
            });
            let vertex_layouts = [
                Some(wgpu::VertexBufferLayout {
                    array_stride: 12,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[wgpu::VertexAttribute {
                        format: wgpu::VertexFormat::Float32x3,
                        offset: 0,
                        shader_location: 0,
                    }],
                }),
                Some(wgpu::VertexBufferLayout {
                    array_stride: 12,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[wgpu::VertexAttribute {
                        format: wgpu::VertexFormat::Float32x3,
                        offset: 0,
                        shader_location: 1,
                    }],
                }),
                Some(wgpu::VertexBufferLayout {
                    array_stride: 32,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &[
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x3,
                            offset: 0,
                            shader_location: 2,
                        },
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32,
                            offset: 12,
                            shader_location: 3,
                        },
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x3,
                            offset: 16,
                            shader_location: 4,
                        },
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32,
                            offset: 28,
                            shader_location: 5,
                        },
                    ],
                }),
            ];
            let format = surface
                .get_capabilities(&adapter)
                .formats
                .first()
                .copied()
                .unwrap_or(wgpu::TextureFormat::Bgra8Unorm);
            let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: None,
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    compilation_options: Default::default(),
                    buffers: &vertex_layouts,
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_main"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: wgpu::TextureFormat::Depth24Plus,
                    depth_write_enabled: Some(true),
                    depth_compare: Some(wgpu::CompareFunction::Less),
                    stencil: wgpu::StencilState::default(),
                    bias: wgpu::DepthBiasState::default(),
                }),
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            });

            let (positions, normals, indices) = unit_cube();
            let mesh_pos = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(&positions),
                usage: wgpu::BufferUsages::VERTEX,
            });
            let mesh_nrm = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(&normals),
                usage: wgpu::BufferUsages::VERTEX,
            });
            let indices_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(&indices),
                usage: wgpu::BufferUsages::INDEX,
            });
            let instances = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(&instance_data()),
                usage: wgpu::BufferUsages::VERTEX,
            });
            let uniforms = device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size: std::mem::size_of::<Uniforms>() as u64,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
                layout: &bind_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniforms.as_entire_binding(),
                }],
                label: None,
            });
            Ok(Self {
                gpu: Some(Gpu {
                    device,
                    queue,
                    surface,
                    pipeline,
                    mesh_pos,
                    mesh_nrm,
                    indices: indices_buf,
                    index_count: indices.len() as u32,
                    instances,
                    uniforms,
                    bind,
                    depth: None,
                    size: (0, 0),
                    format,
                }),
            })
        }

        /// 调试用:返回已知点 (0,-1,0) 在 t=1.0 的裁剪坐标与 w。
        #[wasm_bindgen]
        pub fn debug_clip(&self) -> Vec<f32> {
            let aspect = 16.0 / 9.0;
            let m = view_projection(aspect, 1.0);
            let world = [0.0_f32, -1.0, 0.0, 1.0];
            let mut clip = [0.0_f32; 4];
            for r in 0..4 {
                clip[r] = m[r][0] * world[0]
                    + m[r][1] * world[1]
                    + m[r][2] * world[2]
                    + m[r][3] * world[3];
            }
            clip.to_vec()
        }

        /// 调试用:顶点/实例缓冲字节数。
        #[wasm_bindgen]
        pub fn debug_buffer_bytes(&self) -> u32 {
            let gpu = self.gpu.as_ref().expect("gpu");
            (gpu.mesh_pos.size() + gpu.instances.size()) as u32
        }

        /// 每帧:time 秒;canvas 尺寸变化时自动重建深度缓冲。
        #[wasm_bindgen]
        pub fn render_frame(
            &mut self,
            canvas_width: u32,
            canvas_height: u32,
            time: f32,
        ) -> Result<(), JsValue> {
            let gpu = self
                .gpu
                .as_mut()
                .ok_or_else(|| JsValue::from_str("viewer dropped"))?;
            let size = (canvas_width.max(1), canvas_height.max(1));
            if gpu.size != size {
                gpu.surface.configure(
                    &gpu.device,
                    &wgpu::SurfaceConfiguration {
                        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                        format: gpu.format,
                        width: size.0,
                        height: size.1,
                        present_mode: wgpu::PresentMode::Fifo,
                        alpha_mode: wgpu::CompositeAlphaMode::Auto,
                        view_formats: vec![],
                        desired_maximum_frame_latency: 2,
                        color_space: wgpu::SurfaceColorSpace::default(),
                    },
                );
                let depth = gpu.device.create_texture(&wgpu::TextureDescriptor {
                    label: None,
                    size: wgpu::Extent3d {
                        width: size.0,
                        height: size.1,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Depth24Plus,
                    usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                    view_formats: &[],
                });
                gpu.depth = Some(depth.create_view(&wgpu::TextureViewDescriptor::default()));
                gpu.size = size;
            }
            // WGSL mat4x4 按列读取内存;行式数学结果上传前转置,否则等价乘了转置矩阵。
            let m = view_projection(size.0 as f32 / size.1 as f32, time);
            let mut transposed = [[0.0_f32; 4]; 4];
            for (r, row) in m.iter().enumerate() {
                for (c, value) in row.iter().enumerate() {
                    transposed[c][r] = *value;
                }
            }
            gpu.queue.write_buffer(
                &gpu.uniforms,
                0,
                bytemuck::bytes_of(&Uniforms {
                    view_proj: transposed,
                    time,
                    pad: [0.0; 7],
                }),
            );
            let frame = match gpu.surface.get_current_texture() {
                wgpu::CurrentSurfaceTexture::Success(frame)
                | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
                other => return Err(JsValue::from_str(&format!("acquire: {other:?}"))),
            };
            let view = frame
                .texture
                .create_view(&wgpu::TextureViewDescriptor::default());
            let mut encoder = gpu
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: None,
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        resolve_target: None,
                        depth_slice: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color {
                                r: 0.043,
                                g: 0.066,
                                b: 0.078,
                                a: 1.0,
                            }),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                        view: gpu
                            .depth
                            .as_ref()
                            .ok_or_else(|| JsValue::from_str("depth missing"))?,
                        depth_ops: Some(wgpu::Operations {
                            load: wgpu::LoadOp::Clear(1.0),
                            store: wgpu::StoreOp::Store,
                        }),
                        stencil_ops: None,
                    }),
                    timestamp_writes: None,
                    occlusion_query_set: None,
                    multiview_mask: None,
                });
                pass.set_pipeline(&gpu.pipeline);
                pass.set_bind_group(0, &gpu.bind, &[]);
                pass.set_vertex_buffer(0, gpu.mesh_pos.slice(..));
                pass.set_vertex_buffer(1, gpu.mesh_nrm.slice(..));
                pass.set_vertex_buffer(2, gpu.instances.slice(..));
                pass.set_index_buffer(gpu.indices.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..gpu.index_count, 0, 0..INSTANCE_COUNT);
            }
            gpu.queue.submit([encoder.finish()]);
            gpu.queue.present(frame);
            Ok(())
        }
    }
}
#[cfg(feature = "bench-viewer")]
pub use bench::Viewer;
