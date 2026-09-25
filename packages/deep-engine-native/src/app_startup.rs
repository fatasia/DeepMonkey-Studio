use winit::{dpi::PhysicalSize, window::WindowAttributes};

use crate::renderer::Renderer;

#[cfg(target_arch = "wasm32")]
thread_local! {
    static WASM_CANVAS: std::cell::RefCell<Option<web_sys::HtmlCanvasElement>> = const { std::cell::RefCell::new(None) };
    static WASM_WINDOW_CANVAS: std::cell::RefCell<Option<web_sys::HtmlCanvasElement>> = const { std::cell::RefCell::new(None) };
    static WASM_RENDERER_READY_GENERATION: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    static WASM_RENDERER_FAILURE: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

#[cfg(target_arch = "wasm32")]
pub fn set_wasm_canvas(canvas: Option<web_sys::HtmlCanvasElement>) {
    WASM_CANVAS.with(|slot| *slot.borrow_mut() = canvas);
}

#[cfg(target_arch = "wasm32")]
pub fn remember_wasm_window_canvas(window: &winit::window::Window) {
    use winit::platform::web::WindowExtWebSys;
    WASM_WINDOW_CANVAS.with(|slot| *slot.borrow_mut() = window.canvas());
}

#[cfg(target_arch = "wasm32")]
pub fn wasm_window_canvas() -> Option<web_sys::HtmlCanvasElement> {
    WASM_WINDOW_CANVAS.with(|slot| slot.borrow().clone())
}

#[cfg(target_arch = "wasm32")]
pub fn mark_wasm_renderer_ready() {
    WASM_RENDERER_FAILURE.with(|slot| *slot.borrow_mut() = None);
    WASM_RENDERER_READY_GENERATION.with(|value| value.set(value.get().wrapping_add(1)));
}

#[cfg(target_arch = "wasm32")]
pub fn begin_wasm_renderer_attempt() {
    WASM_RENDERER_FAILURE.with(|slot| *slot.borrow_mut() = None);
}

#[cfg(target_arch = "wasm32")]
pub fn mark_wasm_renderer_failed(message: String) {
    WASM_RENDERER_FAILURE.with(|slot| *slot.borrow_mut() = Some(message));
}

#[cfg(target_arch = "wasm32")]
pub fn wasm_renderer_ready_generation() -> u32 {
    WASM_RENDERER_READY_GENERATION.with(std::cell::Cell::get)
}

#[cfg(target_arch = "wasm32")]
pub fn wasm_renderer_failure() -> Option<String> {
    WASM_RENDERER_FAILURE.with(|slot| slot.borrow().clone())
}

pub fn window_attributes(smoke_frame: bool) -> WindowAttributes {
    let attributes = winit::window::Window::default_attributes()
        .with_title(crate::window_chrome::title("正在打开"))
        .with_theme(Some(winit::window::Theme::Dark))
        .with_inner_size(winit::dpi::LogicalSize::new(960, 640))
        .with_min_inner_size(winit::dpi::LogicalSize::new(480, 320));
    #[cfg(target_arch = "wasm32")]
    let attributes = {
        use winit::platform::web::WindowAttributesExtWebSys;
        let canvas = WASM_CANVAS.with(|slot| slot.borrow().clone());
        let attributes = if let Some(canvas) = canvas.as_ref() {
            // An injected Studio canvas already owns its CSS layout. The fixed
            // desktop default (960x640) used to overwrite that backing surface,
            // so WASM rendered a different aspect/area from WebGL and WebGPU.
            // Give winit the live logical viewport; it applies device scale to
            // the backing texture and continues to handle later resize events.
            let width = canvas.client_width();
            let height = canvas.client_height();
            if width > 0 && height > 0 {
                attributes.with_inner_size(winit::dpi::LogicalSize::new(width, height))
            } else {
                attributes
            }
        } else {
            attributes
        };
        attributes
            .with_canvas(canvas.clone())
            .with_append(canvas.is_none())
    };
    #[cfg(target_os = "windows")]
    let attributes = {
        use winit::platform::windows::{IconExtWindows, WindowAttributesExtWindows};
        use winit::window::Icon;
        let window_icon = Icon::from_resource(101, None).expect("embedded product window icon");
        let taskbar_icon = Icon::from_resource(101, Some(PhysicalSize::new(256, 256)))
            .expect("embedded product taskbar icon");
        attributes
            .with_window_icon(Some(window_icon))
            .with_taskbar_icon(Some(taskbar_icon))
    };
    if !smoke_frame {
        return attributes;
    }
    // Windows only presents compositor-visible swapchains, so the smoke window is tiny/offscreen.
    attributes
        .with_inner_size(PhysicalSize::new(64, 64))
        .with_min_inner_size(PhysicalSize::new(64, 64))
        .with_position(winit::dpi::PhysicalPosition::new(-10_000, -10_000))
}

pub fn report_renderer_ready(renderer: &Renderer) {
    println!(
        "native content profile: {}",
        renderer.content_profile_summary()
    );
    let (pbr, resident_textures) = renderer.pbr_summary();
    let alpha = renderer.alpha_summary();
    let (ibl_id, ibl_revision, ibl) = renderer.ibl_summary();
    let shadow = renderer.shadow_summary();
    let (mesh_pipelines, shadow_pipelines) = renderer.pipeline_counts();
    if let Some((isolated, fallbacks)) = renderer.shader_isolation_summary() {
        println!(
            "native Player ShaderPackage isolation: isolated_packages={} fallback_materials={}",
            isolated.len(),
            fallbacks
        );
    }
    let culling = renderer.culling_summary();
    println!(
        "native PBR prepared: authored_textures={} fallback_textures={} resident_textures={} mip_levels={} srgb={} linear={} material_bindings={}",
        pbr.textures,
        resident_textures - pbr.textures,
        resident_textures,
        pbr.mip_levels,
        pbr.srgb_textures,
        pbr.linear_textures,
        pbr.material_bindings
    );
    println!(
        "native alpha prepared: opaque_batches={} mask_batches={} blend_batches={} double_sided_batches={} pipeline_variants={} shadow_pipeline_variants={}",
        alpha.opaque_batches,
        alpha.mask_batches,
        alpha.blend_batches,
        alpha.double_sided_batches,
        mesh_pipelines,
        shadow_pipelines
    );
    println!(
        "native IBL prepared: id={ibl_id} revision={ibl_revision} specular_mips={} specular_texels={} diffuse_texels={} brdf_texels={} format=rgba16float bindings=group0/b3,b4,b5,b6",
        ibl.specular_mips, ibl.specular_texels, ibl.diffuse_texels, ibl.brdf_texels
    );
    println!(
        "native CSM prepared: cascades={} map={}x{} depth_bytes={} caster_stride={} array_texture=depth32float",
        shadow.cascade_count,
        shadow.map_size,
        shadow.map_size,
        shadow.depth_texture_bytes,
        shadow.shadow_frame_stride
    );
    println!(
        "native GPU culling prepared: candidates={} batches={} views={} dispatch_workgroups={} allocated_bytes={} draw=indexed-indirect",
        culling.candidate_instances,
        culling.batches,
        culling.views,
        culling.dispatch_workgroups,
        culling.allocated_bytes
    );
    if let Some(painter) = renderer.deep2d_summary() {
        if let Some(cache) = renderer.deep2d_path_cache_stats() {
            let reasons = cache.miss_reasons;
            println!(
                "native Deep2d path cache: hits={} misses={} entries={} payload_bytes={} evictions={} deletions={}",
                cache.hits,
                cache.misses,
                cache.entries,
                cache.payload_bytes,
                cache.evictions,
                cache.deletions
            );
            // 与 vertex transfer 的 reasons 一起构成两层账:
            // 这一层回答「细分为什么重算」,那一层回答「顶点为什么重传」。
            println!(
                "native Deep2d path cache misses: camera={} epoch={} structure={} clip={} resource={} style={} evicted={}",
                reasons.camera_changed,
                reasons.epoch_changed,
                reasons.structure_changed,
                reasons.clip_changed,
                reasons.resource_changed,
                reasons.style_changed,
                reasons.evicted
            );
        }
        if let Some(transfer) = renderer.deep2d_vertex_transfer_stats() {
            println!(
                "native Deep2d vertex transfer: uploaded={} copied={} reused={} upload_regions={} copy_regions={} cpu_shadow={}",
                transfer.uploaded_bytes,
                transfer.copied_bytes,
                transfer.reused_bytes,
                transfer.upload_regions,
                transfer.copy_regions,
                transfer.shadow_bytes
            );
            let reasons = transfer.reasons;
            println!(
                "native Deep2d vertex transfer reasons: content_reused={} incremental_copies={} no_previous_frame={} previous_not_copyable={} plan_rejected={} below_copy_threshold={} stages={}",
                reasons.content_reused,
                reasons.incremental_copies,
                reasons.no_previous_frame,
                reasons.previous_not_copyable,
                reasons.plan_rejected,
                reasons.below_copy_threshold,
                reasons.total()
            );
        }
        println!(
            "native Deep2d prepared: commands={} path_segments={} fill_triangles={} stroke_triangles={} vertices={}",
            painter.path.commands,
            painter.path.path_segments,
            painter.path.fill_triangles,
            painter.path.stroke_triangles,
            painter.path.vertices
        );
        if painter.atlases > 0 {
            if let Some(inventory) = renderer.deep2d_atlas_inventory() {
                println!(
                    "native Deep2d atlas inventory: {}",
                    serde_json::to_string(inventory).expect("atlas inventory serialization")
                );
            }
            println!(
                "native Deep2d atlases prepared: atlases={} bytes={} glyph_quads={} image_quads={} batches={} vertices={} chunks={}",
                painter.atlases,
                painter.atlas_bytes,
                painter.glyph_quads,
                painter.image_quads,
                painter.atlas_batches,
                painter.atlas_vertices,
                painter.render_chunks
            );
        }
    }
}

pub fn report_presented(size: PhysicalSize<u32>, has_deep2d: bool) {
    if has_deep2d {
        println!(
            "native Deep2d smoke frame presented: {}x{}",
            size.width, size.height
        );
    } else {
        println!(
            "native smoke frame presented: {}x{}",
            size.width, size.height
        );
    }
}
