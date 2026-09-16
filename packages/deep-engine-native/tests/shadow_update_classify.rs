//! Integration tests for the shadow-relevance classifier (delivery backlog §7.3 #20).
//! The classifier lives in the bin module tree, so this target compiles the same file
//! via `#[path]`; the module only depends on the lib contract, never on the bin.

#[path = "shadow_update_classify/mask_cases.rs"]
mod mask_cases;
#[path = "../src/shadow_update_classify.rs"]
mod shadow_update_classify;

use std::path::Path;

use deep_engine_native::contract::{
    AlphaMode, GeometryResource, RenderInstance, RenderPacket, TextureResource, TextureSemantic,
    TextureSlot, load_and_validate,
};
use shadow_update_classify::{ShadowInvalidation, classify_shadow_relevance};

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/fixtures/render_packet_shadow_v1.json"
);

/// Fixture: geometry `shadow-quad`; materials [0]=receiver OPAQUE, [1]=caster OPAQUE;
/// instances [0]=`receiver`, [1]=`caster`; no textures.
fn fixture_packet() -> RenderPacket {
    load_and_validate(Path::new(FIXTURE))
        .expect("shadow fixture loads and validates")
        .0
}

fn edit<T>(
    packet: &mut RenderPacket,
    select: fn(&mut RenderPacket) -> &mut Vec<T>,
    change: impl FnOnce(&mut Vec<T>),
) {
    let mut items = std::mem::take(select(packet));
    change(&mut items);
    *select(packet) = items;
}

fn slot(texture: &str) -> TextureSlot {
    TextureSlot {
        texture: texture.to_string(),
        tex_coord: None,
        offset: None,
        scale: None,
        rotation: None,
    }
}

fn texture(id: &str, semantic: TextureSemantic, data: Vec<u8>) -> TextureResource {
    TextureResource {
        id: id.to_string(),
        revision: 1,
        semantic,
        width: 2,
        height: 2,
        data,
        bytes_per_row: None,
        mipmaps: Vec::new(),
        sampler: None,
    }
}

/// Receiver (materials[0]) becomes a MASK caster sampling an alpha map.
fn mask_receiver_with_map(packet: &mut RenderPacket) {
    edit(
        &mut *packet,
        |p| &mut p.materials,
        |materials| {
            materials[0].alpha_mode = Some(AlphaMode::Mask);
            materials[0].alpha_cutoff = Some(0.5);
            materials[0].base_color_texture = Some(slot("alpha-map"));
        },
    );
    packet.textures.push(texture(
        "alpha-map",
        TextureSemantic::BaseColor,
        vec![255, 0, 0, 255],
    ));
}

fn check(old: &RenderPacket, new: &RenderPacket, expected: Option<ShadowInvalidation>) {
    let relevance = classify_shadow_relevance(old, new);
    assert_eq!(
        (relevance.must_invalidate, relevance.invalidation),
        (expected.is_some(), expected),
        "reason: {}",
        relevance.reason
    );
}

#[test]
fn identical_packets_do_not_invalidate() {
    let packet = fixture_packet();
    check(&packet, &fixture_packet(), None);
}

#[test]
fn emissive_only_updates_are_ignored() {
    let mut updated = fixture_packet();
    edit(
        &mut updated,
        |p| &mut p.materials,
        |materials| {
            materials[1].emissive_factor = Some([1.0, 0.2, 0.4]);
            materials[1].emissive_texture = Some(slot("glow-map"));
        },
    );
    updated.textures.push(texture(
        "glow-map",
        TextureSemantic::Emissive,
        vec![10, 20, 30, 40],
    ));
    check(&fixture_packet(), &updated, None);
}

#[test]
fn instance_changes_invalidate() {
    let mut moved = fixture_packet();
    edit(
        &mut moved,
        |p| &mut p.instances,
        |i| i[1].transform[12] += 0.25,
    );
    check(
        &fixture_packet(),
        &moved,
        Some(ShadowInvalidation::InstanceSet),
    );

    let mut added = fixture_packet();
    edit(
        &mut added,
        |p| &mut p.instances,
        |instances| {
            instances.push(RenderInstance {
                id: "observer".into(),
                geometry: "shadow-quad".into(),
                material: "shadow-caster".into(),
                transform: [
                    1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 2., 0., 0., 1.,
                ],
                lod: None,
                cast_shadow: None,
                receive_shadow: None,
            });
        },
    );
    check(
        &fixture_packet(),
        &added,
        Some(ShadowInvalidation::InstanceSet),
    );
    check(
        &added,
        &fixture_packet(),
        Some(ShadowInvalidation::InstanceSet),
    );
}

#[test]
fn geometry_content_changes_invalidate() {
    let mut revertexed = fixture_packet();
    edit(
        &mut revertexed,
        |p| &mut p.geometries,
        |g| g[0].vertices[0] -= 0.5,
    );
    check(
        &fixture_packet(),
        &revertexed,
        Some(ShadowInvalidation::GeometryContent),
    );

    let mut reindexed = fixture_packet();
    edit(
        &mut reindexed,
        |p| &mut p.geometries,
        |g| g[0].indices[2] = 3,
    );
    check(
        &fixture_packet(),
        &reindexed,
        Some(ShadowInvalidation::GeometryContent),
    );
}

#[test]
fn non_rendering_metadata_is_ignored() {
    let mut bumped = fixture_packet();
    edit(&mut bumped, |p| &mut p.geometries, |g| g[0].revision = 7);
    check(&fixture_packet(), &bumped, None);

    let unused = |vertices: [f32; 3]| GeometryResource {
        id: "unused-geom".into(),
        revision: 1,
        vertices: vertices.to_vec(),
        uv0: None,
        uv1: None,
        tangents: None,
        indices: vec![0],
    };
    let mut with_unused = fixture_packet();
    edit(
        &mut with_unused,
        |p| &mut p.geometries,
        |g| g.push(unused([0.0, 0.0, 0.0])),
    );
    check(&fixture_packet(), &with_unused, None);
    let mut mutated = fixture_packet();
    edit(
        &mut mutated,
        |p| &mut p.geometries,
        |g| g.push(unused([9.0, 9.0, 9.0])),
    );
    check(&with_unused, &mutated, None);

    let mut opaque_alpha = fixture_packet();
    edit(
        &mut opaque_alpha,
        |p| &mut p.materials,
        |m| {
            m[0].alpha_cutoff = Some(0.5);
            m[0].base_color_alpha = Some(0.5);
        },
    );
    check(&fixture_packet(), &opaque_alpha, None);

    let mut uv_shifted = fixture_packet();
    edit(
        &mut uv_shifted,
        |p| &mut p.geometries,
        |g| {
            g[0].uv0 = Some(vec![0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0]);
        },
    );
    check(&fixture_packet(), &uv_shifted, None);

    let mut normal_mapped = fixture_packet();
    normal_mapped
        .textures
        .push(texture("detail", TextureSemantic::Normal, vec![1, 2, 3, 4]));
    check(&fixture_packet(), &normal_mapped, None);
}

#[test]
fn material_caster_changes_invalidate() {
    let mut masked = fixture_packet();
    edit(
        &mut masked,
        |p| &mut p.materials,
        |m| {
            m[0].alpha_mode = Some(AlphaMode::Mask);
            m[0].alpha_cutoff = Some(0.5);
        },
    );
    check(
        &fixture_packet(),
        &masked,
        Some(ShadowInvalidation::MaterialCaster),
    );

    let mut blended = fixture_packet();
    edit(
        &mut blended,
        |p| &mut p.materials,
        |m| m[1].alpha_mode = Some(AlphaMode::Blend),
    );
    check(
        &fixture_packet(),
        &blended,
        Some(ShadowInvalidation::MaterialCaster),
    );

    let mut double_sided = fixture_packet();
    edit(
        &mut double_sided,
        |p| &mut p.materials,
        |m| m[1].double_sided = Some(true),
    );
    check(
        &fixture_packet(),
        &double_sided,
        Some(ShadowInvalidation::MaterialCaster),
    );

    let mut drifted = fixture_packet();
    drifted.version = 2;
    check(
        &fixture_packet(),
        &drifted,
        Some(ShadowInvalidation::ContractIdentity),
    );
}
