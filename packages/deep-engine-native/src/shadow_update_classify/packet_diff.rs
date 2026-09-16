use std::collections::{HashMap, HashSet};

use deep_engine_native::contract::{
    GeometryResource, PbrMaterial, RenderInstance, RenderPacket, TextureResource,
};

use super::{
    ShadowInvalidation, ShadowRelevance,
    value_compare::{
        f32_slice_changed, geometry_content_changed, lod_changed, mask_inputs,
        material_caster_changed, referenced_geometries, texture_content_changed,
    },
};

/// Shared by-id diff skeleton. Unreferenced resources never affect shadows.
fn diff_indexed<T>(
    old: &HashMap<&str, &T>,
    new: &HashMap<&str, &T>,
    removal_matters: impl Fn(&str) -> bool,
    addition_matters: impl Fn(&str) -> bool,
    changed: impl Fn(&str, &T, &T) -> Option<String>,
    kind: ShadowInvalidation,
    noun: &str,
) -> Option<ShadowRelevance> {
    for (id, value) in old {
        match new.get(id) {
            None if removal_matters(id) => {
                return Some(ShadowRelevance::changed(
                    kind,
                    format!("{noun} `{id}` removed"),
                ));
            }
            Some(updated) if removal_matters(id) || addition_matters(id) => {
                if let Some(detail) = changed(id, value, updated) {
                    return Some(ShadowRelevance::changed(
                        kind,
                        format!("{noun} `{id}` {detail}"),
                    ));
                }
            }
            Some(_) | None => {}
        }
    }
    new.keys()
        .find(|id| !old.contains_key(*id) && addition_matters(id))
        .map(|id| ShadowRelevance::changed(kind, format!("{noun} `{id}` added")))
}

fn instance_map(packet: &RenderPacket) -> HashMap<&str, &RenderInstance> {
    packet
        .instances
        .iter()
        .map(|value| (value.id.as_str(), value))
        .collect()
}

fn material_map(packet: &RenderPacket) -> HashMap<&str, &PbrMaterial> {
    packet
        .materials
        .iter()
        .map(|value| (value.id.as_str(), value))
        .collect()
}

fn geometry_map(packet: &RenderPacket) -> HashMap<&str, &GeometryResource> {
    packet
        .geometries
        .iter()
        .map(|value| (value.id.as_str(), value))
        .collect()
}

fn texture_map(packet: &RenderPacket) -> HashMap<&str, &TextureResource> {
    packet
        .textures
        .iter()
        .map(|value| (value.id.as_str(), value))
        .collect()
}

pub(super) fn instances_changed(old: &RenderPacket, new: &RenderPacket) -> Option<ShadowRelevance> {
    let old_map = instance_map(old);
    let new_map = instance_map(new);
    diff_indexed(
        &old_map,
        &new_map,
        |_| true,
        |_| true,
        |_, a, b| {
            if a.cast_shadow.unwrap_or(true) != b.cast_shadow.unwrap_or(true) {
                return Some("castShadow changed".into());
            }
            if a.geometry != b.geometry || a.material != b.material {
                return Some("geometry/material reference changed".into());
            }
            if f32_slice_changed(&a.transform, &b.transform) {
                return Some("transform changed".into());
            }
            lod_changed(a.lod.as_ref(), b.lod.as_ref()).then_some("LOD profile changed".into())
        },
        ShadowInvalidation::InstanceSet,
        "instance",
    )
}

pub(super) fn materials_changed(old: &RenderPacket, new: &RenderPacket) -> Option<ShadowRelevance> {
    let old_map = material_map(old);
    let new_map = material_map(new);
    let referenced: HashSet<&str> = old
        .instances
        .iter()
        .chain(&new.instances)
        .map(|instance| instance.material.as_str())
        .collect();
    diff_indexed(
        &old_map,
        &new_map,
        |id| referenced.contains(id),
        |id| referenced.contains(id),
        |_, a, b| material_caster_changed(a, b),
        ShadowInvalidation::MaterialCaster,
        "material",
    )
}

pub(super) fn geometries_changed(
    old: &RenderPacket,
    new: &RenderPacket,
) -> Option<ShadowRelevance> {
    let old_map = geometry_map(old);
    let new_map = geometry_map(new);
    let mut referenced = referenced_geometries(old);
    referenced.extend(referenced_geometries(new));
    let mut uv0 = mask_inputs(old).uv0_geometries;
    uv0.extend(mask_inputs(new).uv0_geometries);
    diff_indexed(
        &old_map,
        &new_map,
        |id| referenced.contains(id),
        |id| referenced.contains(id),
        |id, a, b| geometry_content_changed(a, b, uv0.contains(id)),
        ShadowInvalidation::GeometryContent,
        "geometry",
    )
}

pub(super) fn textures_changed(old: &RenderPacket, new: &RenderPacket) -> Option<ShadowRelevance> {
    let old_map = texture_map(old);
    let new_map = texture_map(new);
    let mut alpha_textures = mask_inputs(old).alpha_textures;
    alpha_textures.extend(mask_inputs(new).alpha_textures);
    diff_indexed(
        &old_map,
        &new_map,
        |id| alpha_textures.contains(id),
        |id| alpha_textures.contains(id),
        |_, a, b| texture_content_changed(a, b),
        ShadowInvalidation::TextureContent,
        "texture",
    )
}
