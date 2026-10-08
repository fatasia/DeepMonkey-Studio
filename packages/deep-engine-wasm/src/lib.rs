//! DeepMonkey wasm:全引擎镜像集成 + 三方案对比 bench viewer。
//! 镜像模块必须位于 crate 根(bin 树的 crate::app 等路径依赖此布局)。

use wasm_bindgen::prelude::*;

mod physics_pose;
mod scene_package_async;
pub use physics_pose::viewer_physics_pose;

thread_local! {
    static SCENE_PACKAGE: std::cell::RefCell<Option<runtime_package_startup::PreparedRuntimePackage>> = const { std::cell::RefCell::new(None) };
    static VIEWER_SESSIONS: std::cell::RefCell<std::collections::BTreeMap<u32, winit::event_loop::EventLoopProxy<events::GpuEvent>>> = const { std::cell::RefCell::new(std::collections::BTreeMap::new()) };
    static NEXT_VIEWER_SESSION: std::cell::Cell<u32> = const { std::cell::Cell::new(1) };
}

#[wasm_bindgen]
pub fn set_scene_package(bytes: &[u8]) -> Result<(), JsValue> {
    let package =
        runtime_package_startup::load_bytes(bytes).map_err(|error| JsValue::from_str(&error))?;
    SCENE_PACKAGE.with(|slot| *slot.borrow_mut() = Some(package));
    Ok(())
}

/// Recompute the canonical package hash on the compilation worker's own wasm
/// instance. Same function as the consuming thread's verification path, so the
/// value is domain-identical; the main thread then verifies against it instead
/// of re-walking the tree a second time.
#[wasm_bindgen]
pub fn compute_runtime_package_canonical_hash(bytes: &[u8]) -> Result<String, JsValue> {
    deep_engine_native::runtime_package::compute_runtime_package_canonical_hash(bytes)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Verification against the worker-computed canonical hash; every other check
/// matches `set_scene_package` exactly.
#[wasm_bindgen]
pub fn set_scene_package_with_expected_hash(
    bytes: &[u8],
    expected_hash: &str,
) -> Result<(), JsValue> {
    let package = runtime_package_startup::load_bytes_with_expected_hash(bytes, expected_hash)
        .map_err(|error| JsValue::from_str(&error))?;
    SCENE_PACKAGE.with(|slot| *slot.borrow_mut() = Some(package));
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
    let package = SCENE_PACKAGE
        .with(|slot| slot.borrow_mut().take())
        .ok_or_else(|| {
            JsValue::from_str("scene package was not injected or was already consumed")
        })?;
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
        app_startup::reject_wasm_physics_pose_requests("scene viewer stopped");
        let _ = proxy.send_event(events::GpuEvent::WasmStop);
    }
}

/// Parked viewers retain GPU resources without rendering or advancing playback.
#[wasm_bindgen]
pub fn set_scene_viewer_paused(handle: u32, paused: bool) -> Result<(), JsValue> {
    let proxy = VIEWER_SESSIONS.with(|sessions| sessions.borrow().get(&handle).cloned())
        .ok_or_else(|| JsValue::from_str("scene viewer handle is not active"))?;
    proxy.send_event(events::GpuEvent::WasmPresentationPaused(paused))
        .map_err(|_| JsValue::from_str("scene viewer event loop is closed"))
}

#[wasm_bindgen]
pub fn update_scene_viewer(handle: u32, bytes: &[u8]) -> Result<(), JsValue> {
    let proxy = VIEWER_SESSIONS
        .with(|sessions| sessions.borrow().get(&handle).cloned())
        .ok_or_else(|| JsValue::from_str("scene viewer handle is not active"))?;
    let package =
        runtime_package_startup::load_bytes(bytes).map_err(|error| JsValue::from_str(&error))?;
    proxy
        .send_event(events::GpuEvent::WasmScenePackage(Box::new(package)))
        .map_err(|_| JsValue::from_str("scene viewer event loop is closed"))
}

/// Same validation as `update_scene_viewer`, verifying against the
/// worker-computed canonical hash instead of re-walking the tree.
#[wasm_bindgen]
pub fn update_scene_viewer_with_expected_hash(
    handle: u32,
    bytes: &[u8],
    expected_hash: &str,
) -> Result<(), JsValue> {
    let proxy = VIEWER_SESSIONS
        .with(|sessions| sessions.borrow().get(&handle).cloned())
        .ok_or_else(|| JsValue::from_str("scene viewer handle is not active"))?;
    let package = runtime_package_startup::load_bytes_with_expected_hash(bytes, expected_hash)
        .map_err(|error| JsValue::from_str(&error))?;
    proxy
        .send_event(events::GpuEvent::WasmScenePackage(Box::new(package)))
        .map_err(|_| JsValue::from_str("scene viewer event loop is closed"))
}

#[wasm_bindgen]
pub fn update_editor_overlay(handle: u32, revision: u32, vertices: &[f32]) -> Result<(), JsValue> {
    if vertices.len() % 24 != 0 || vertices.len() > 196_608 * 8 {
        return Err(JsValue::from_str(
            "WASM editor overlay layout or vertex budget is invalid",
        ));
    }
    let proxy = VIEWER_SESSIONS
        .with(|sessions| sessions.borrow().get(&handle).cloned())
        .ok_or_else(|| JsValue::from_str("scene viewer handle is not active"))?;
    proxy
        .send_event(events::GpuEvent::WasmEditorOverlay {
            revision: u64::from(revision),
            vertices: vertices.to_vec(),
        })
        .map_err(|_| JsValue::from_str("scene viewer event loop is closed"))
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
pub fn scene_viewer_memory_bytes() -> usize {
    core::arch::wasm32::memory_size(0) * 65_536
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

#[path = "../../deep-engine-native/src/deep2d_backdrop_gpu.rs"]
pub mod deep2d_backdrop_gpu;
#[path = "../../deep-engine-native/src/deep2d_dynamic_gpu.rs"]
pub mod deep2d_dynamic_gpu;
#[path = "../../deep-engine-native/src/deep2d_frame_context.rs"]
pub mod deep2d_frame_context;

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
#[cfg(feature = "bench-viewer")]
#[path = "bench_viewer.rs"]
pub mod bench_viewer;
#[cfg(feature = "bench-viewer")]
pub use bench_viewer::bench;
