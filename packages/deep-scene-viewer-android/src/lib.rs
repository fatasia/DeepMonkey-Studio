//! 场景安卓查看器壳:cdylib 导出 NativeActivity 入口,经 #[path] 复用
//! deep-engine-native bin 树的完整播放器实现,不复制任何代码。

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

// 场景安卓发布首片:native-activity 入口。APK assets 里的 runtime-package.json
// 先落到应用私有目录,再走与 Windows EXE 完全相同的 --package 播放链;
// 不引入第二套播放器、第二套资产协议。
#[cfg(target_os = "android")]
static ANDROID_APP: std::sync::OnceLock<android_activity::AndroidApp> = std::sync::OnceLock::new();

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
fn android_main(mut app: android_activity::AndroidApp) {
    // AndroidApp::internal_data_path 在该环境必崩(SIGSEGV,已符号化证实):
    // 应用自有目录改用字面路径 + create_dir_all,不触碰该 API。
    let data_dir = std::path::PathBuf::from("/data/data/com.deepmonkey.sceneviewer/files");
    let _ = std::fs::create_dir_all(&data_dir);
    let mut log = android_file_log::FileLog::open(Some(data_dir.as_path()), "android_main");
    let package_path = match materialize_scene_package(&app, &data_dir) {
        Ok(path) => path,
        Err(error) => {
            log.write(&format!("scene package missing: {error}"));
            return;
        }
    };
    log.write(&format!("package ready: {}", package_path.display()));
    // android-activity 0.6 的 android_main 按值收取 AndroidApp(引用签名=胶水按值传+按引用解=SIGSEGV)。
    if ANDROID_APP.set(app).is_err() {
        log.write("android app already set");
        return;
    }
    let args = [
        std::ffi::OsString::from("--package"),
        package_path.into_os_string(),
    ];
    if let Err(error) = cli::execute_from(args) {
        log.write(&format!("player failed: {error}"));
    }
}

/// 场景包模板约定:模板 APK 的 `assets/runtime-package.json` 是自包含场景包
/// (与 Windows portable 包同一文件、同一 SHA-256 合同)。
#[cfg(target_os = "android")]
fn materialize_scene_package(
    app: &android_activity::AndroidApp,
    data_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    use std::io::Read;
    let mut asset = app
        .asset_manager()
        .open(&std::ffi::CString::new("runtime-package.json").expect("asset path"))
        .ok_or("assets/runtime-package.json not present in APK")?;
    let mut bytes = Vec::new();
    asset
        .read_to_end(&mut bytes)
        .map_err(|error| format!("asset read failed: {error}"))?;
    let path = data_dir.join("runtime-package.json");
    std::fs::write(&path, &bytes).map_err(|error| format!("package write failed: {error}"))?;
    Ok(path)
}

/// 无 android_logger 依赖的文件日志:`<data_dir>/deep-native.log`,
/// 调试期 `adb shell run-as <pkg> cat files/deep-native.log` 可取。
#[cfg(target_os = "android")]
mod android_file_log {
    use std::ffi::CString;
    use std::io::Write;
    use std::os::raw::c_char;
    use std::path::Path;

    #[link(name = "log")]
    unsafe extern "C" {
        fn __android_log_write(priority: i32, tag: *const c_char, text: *const c_char) -> i32;
    }

    pub(crate) struct FileLog(Option<std::fs::File>);
    impl FileLog {
        pub(crate) fn open(dir: Option<&Path>, marker: &str) -> Self {
            let file = dir.and_then(|dir| {
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(dir.join("deep-native.log"))
                    .ok()
            });
            let mut log = Self(file);
            log.write(&format!("--- {marker} ---"));
            log
        }
        pub(crate) fn write(&mut self, line: &str) {
            if let Some(file) = self.0.as_mut() {
                let _ = writeln!(file, "{line}");
            }
            let tag = CString::new("DeepMonkey").expect("static Android log tag");
            let text = CString::new(line.replace('\0', "�")).expect("NUL was replaced");
            // Android log priority 4 = INFO. Keep logcat as a production-safe diagnostic
            // path because release APKs deliberately disable `run-as` access.
            unsafe { __android_log_write(4, tag.as_ptr(), text.as_ptr()) };
        }
    }
}
