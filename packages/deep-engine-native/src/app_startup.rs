use winit::{dpi::PhysicalSize, window::WindowAttributes};

use crate::{
    pipeline::{MESH_PIPELINE_VARIANTS, SHADOW_PIPELINE_VARIANTS},
    renderer::Renderer,
};

pub fn window_attributes(smoke_frame: bool) -> WindowAttributes {
    let attributes = winit::window::Window::default_attributes()
        .with_title("Deep Engine Native Viewer — starting GPU")
        .with_inner_size(winit::dpi::LogicalSize::new(960, 640))
        .with_min_inner_size(winit::dpi::LogicalSize::new(480, 320));
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
    let (pbr, resident_textures) = renderer.pbr_summary();
    let alpha = renderer.alpha_summary();
    let (ibl_id, ibl_revision, ibl) = renderer.ibl_summary();
    let shadow = renderer.shadow_summary();
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
        MESH_PIPELINE_VARIANTS,
        SHADOW_PIPELINE_VARIANTS
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
        println!(
            "native Deep2d prepared: commands={} path_segments={} fill_triangles={} stroke_triangles={} vertices={}",
            painter.path.commands,
            painter.path.path_segments,
            painter.path.fill_triangles,
            painter.path.stroke_triangles,
            painter.path.vertices
        );
        if painter.atlases > 0 {
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
