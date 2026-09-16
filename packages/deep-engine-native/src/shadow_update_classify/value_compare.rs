use std::collections::{HashMap, HashSet};

use deep_engine_native::contract::{
    AlphaMode, GeometryResource, PbrMaterial, PixelLevel, RenderLodProfile, RenderPacket,
    TextureResource, TextureSlot,
};

/// Only caster selection, the double-sided pipeline pick and MASK alpha inputs
/// matter; emissive, metallic/roughness and normal/occlusion slots never reach the
/// shadow pass. Blend materials cast nothing, so even doubleSided is irrelevant.
pub(super) fn material_caster_changed(a: &PbrMaterial, b: &PbrMaterial) -> Option<String> {
    if a.alpha_mode != b.alpha_mode {
        return Some(format!(
            "alphaMode {:?} -> {:?}",
            a.alpha_mode, b.alpha_mode
        ));
    }
    if a.alpha_mode == Some(AlphaMode::Blend) {
        return None;
    }
    if a.double_sided != b.double_sided {
        return Some("doubleSided changed".into());
    }
    if a.alpha_mode == Some(AlphaMode::Mask) {
        if !opt_f32_eq(a.alpha_cutoff, b.alpha_cutoff) {
            return Some("alphaCutoff changed".into());
        }
        if !opt_f32_eq(a.base_color_alpha, b.base_color_alpha) {
            return Some("baseColorAlpha changed".into());
        }
        if slot_changed(a.base_color_texture.as_ref(), b.base_color_texture.as_ref()) {
            return Some("baseColor texture slot changed".into());
        }
    }
    None
}

/// vertices/indices always matter (bounds + shape); uv0 only when a MASK caster with
/// a baseColor map samples it; uv1/tangents never enter the shadow depth pass.
pub(super) fn geometry_content_changed(
    a: &GeometryResource,
    b: &GeometryResource,
    check_uv0: bool,
) -> Option<String> {
    if f32_slice_changed(&a.vertices, &b.vertices) {
        return Some("vertices changed".into());
    }
    if a.indices != b.indices {
        return Some("indices changed".into());
    }
    if check_uv0 && opt_f32_slice_changed(a.uv0.as_deref(), b.uv0.as_deref()) {
        return Some("uv0 changed under MASK baseColor sampling".into());
    }
    None
}

/// Samplers only change filtering quality, never coverage; the semantic tag is
/// metadata beside the slot that actually consumes the texture.
pub(super) fn texture_content_changed(a: &TextureResource, b: &TextureResource) -> Option<String> {
    if (a.width, a.height) != (b.width, b.height) {
        return Some("size changed".into());
    }
    if a.data != b.data || a.bytes_per_row != b.bytes_per_row {
        return Some("base level changed".into());
    }
    let mipmap_changed = |x: &PixelLevel, y: &PixelLevel| {
        (x.width, x.height, x.bytes_per_row) != (y.width, y.height, y.bytes_per_row)
            || x.data != y.data
    };
    (a.mipmaps.len() != b.mipmaps.len()
        || a.mipmaps
            .iter()
            .zip(&b.mipmaps)
            .any(|(x, y)| mipmap_changed(x, y)))
    .then_some("mipmaps changed".into())
}

/// Textures feeding MASK alpha coverage, and geometries whose uv0 that coverage
/// samples through (Mask + baseColor map, including LOD levels).
#[derive(Default)]
pub(super) struct MaskInputs<'a> {
    pub(super) alpha_textures: HashSet<&'a str>,
    pub(super) uv0_geometries: HashSet<&'a str>,
}

pub(super) fn mask_inputs(packet: &RenderPacket) -> MaskInputs<'_> {
    let mut inputs = MaskInputs::default();
    for material in &packet.materials {
        if material.alpha_mode == Some(AlphaMode::Mask)
            && let Some(slot) = &material.base_color_texture
        {
            inputs.alpha_textures.insert(slot.texture.as_str());
        }
    }
    let materials: HashMap<&str, &PbrMaterial> = packet
        .materials
        .iter()
        .map(|material| (material.id.as_str(), material))
        .collect();
    for instance in &packet.instances {
        let Some(material) = materials.get(instance.material.as_str()) else {
            continue;
        };
        let mask_mapped =
            material.alpha_mode == Some(AlphaMode::Mask) && material.base_color_texture.is_some();
        if !mask_mapped {
            continue;
        }
        inputs.uv0_geometries.insert(instance.geometry.as_str());
        if let Some(profile) = &instance.lod {
            inputs
                .uv0_geometries
                .extend(profile.levels.iter().map(|level| level.geometry.as_str()));
        }
    }
    inputs
}

pub(super) fn referenced_geometries(packet: &RenderPacket) -> HashSet<&str> {
    let mut used = HashSet::new();
    for instance in &packet.instances {
        used.insert(instance.geometry.as_str());
        if let Some(profile) = &instance.lod {
            used.extend(profile.levels.iter().map(|level| level.geometry.as_str()));
        }
    }
    used
}

/// Bit-exact float keys: -0.0 and 0.0 name the same point, NaN bits differ and
/// conservatively read as a change (validated packets reject non-finite values).
fn f32_bits(value: f32) -> u32 {
    if value == 0.0 { 0 } else { value.to_bits() }
}

pub(super) fn f32_slice_changed(a: &[f32], b: &[f32]) -> bool {
    a.len() != b.len() || a.iter().zip(b).any(|(x, y)| f32_bits(*x) != f32_bits(*y))
}

fn opt_f32_slice_changed(a: Option<&[f32]>, b: Option<&[f32]>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => f32_slice_changed(a, b),
        (None, None) => false,
        _ => true,
    }
}

fn opt_f32_eq(a: Option<f32>, b: Option<f32>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => f32_bits(a) == f32_bits(b),
        (None, None) => true,
        _ => false,
    }
}

/// Full slot comparison for MASK baseColor: the sampler transform steers alpha
/// sampling, so texCoord/offset/scale/rotation shift shadow coverage too.
fn slot_changed(a: Option<&TextureSlot>, b: Option<&TextureSlot>) -> bool {
    match (a, b) {
        (None, None) => false,
        (Some(a), Some(b)) => {
            a.texture != b.texture
                || a.tex_coord != b.tex_coord
                || !pair_eq(a.offset, b.offset)
                || !pair_eq(a.scale, b.scale)
                || !opt_f32_eq(a.rotation, b.rotation)
        }
        _ => true,
    }
}

fn pair_eq(a: Option<[f32; 2]>, b: Option<[f32; 2]>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => f32_bits(a[0]) == f32_bits(b[0]) && f32_bits(a[1]) == f32_bits(b[1]),
        (None, None) => true,
        _ => false,
    }
}

pub(super) fn lod_changed(a: Option<&RenderLodProfile>, b: Option<&RenderLodProfile>) -> bool {
    let bits = |value: f64| if value == 0.0 { 0 } else { value.to_bits() };
    let eq = |a: Option<f64>, b: Option<f64>| match (a, b) {
        (Some(a), Some(b)) => bits(a) == bits(b),
        (None, None) => true,
        _ => false,
    };
    match (a, b) {
        (None, None) => false,
        (Some(a), Some(b)) => {
            !(a.author == b.author
                && a.levels.len() == b.levels.len()
                && a.levels.iter().zip(&b.levels).all(|(x, y)| {
                    x.geometry == y.geometry
                        && bits(x.min_projected_diameter_pixels)
                            == bits(y.min_projected_diameter_pixels)
                        && bits(x.geometric_error) == bits(y.geometric_error)
                        && x.resident == y.resident
                })
                && eq(a.hysteresis_ratio, b.hysteresis_ratio))
        }
        _ => true,
    }
}
