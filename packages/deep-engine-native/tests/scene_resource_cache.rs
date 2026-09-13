use deep_engine_native::{
    contract::{RenderPacket, default_textured_fixture_path, load_and_validate},
    pbr_texture::prepare_pbr_resources,
    scene::prepare_scene,
    scene_resource_domain::SceneResourceDomain,
    scene_resource_identity::{SceneResourceManifest, scene_resource_manifest},
};

fn packet() -> RenderPacket {
    load_and_validate(default_textured_fixture_path())
        .unwrap()
        .0
}

fn manifest(packet: &RenderPacket) -> SceneResourceManifest {
    scene_resource_manifest(
        packet,
        &prepare_scene(packet).unwrap(),
        &prepare_pbr_resources(packet).unwrap(),
    )
    .unwrap()
}

#[test]
fn identities_are_deterministic_and_split_resource_ownership() {
    let original = packet();
    let first = manifest(&original);
    assert_eq!(first, manifest(&packet()));

    let mut changed = packet();
    changed.instances[0].transform[12] += 0.25;
    let instance_update = manifest(&changed);
    assert_eq!(first.geometries, instance_update.geometries);
    assert_eq!(first.textures, instance_update.textures);
    assert_eq!(first.materials, instance_update.materials);
    assert_ne!(first.instances, instance_update.instances);

    let mut changed = packet();
    changed.materials[0]
        .base_color_texture
        .as_mut()
        .unwrap()
        .offset = Some([0.25, 0.125]);
    let material_update = manifest(&changed);
    assert_eq!(first.geometries, material_update.geometries);
    assert_eq!(first.textures, material_update.textures);
    assert_ne!(first.materials, material_update.materials);
    assert_eq!(first.instances, material_update.instances);
}

#[test]
fn material_identity_follows_texture_identity_instead_of_packet_index() {
    let first = manifest(&packet());
    let mut reordered = packet();
    reordered.textures.reverse();
    let reordered = manifest(&reordered);
    assert_eq!(first.materials, reordered.materials);
    assert_ne!(first.textures, reordered.textures);

    let mut revised = packet();
    revised.textures[0].revision += 1;
    let revised = manifest(&revised);
    assert_ne!(first.textures, revised.textures);
    assert_ne!(first.materials, revised.materials);
}

#[test]
fn reused_geometry_or_texture_revision_with_changed_content_fails_closed() {
    let original = manifest(&packet());
    let mut domain = SceneResourceDomain::new(8);
    domain.commit(domain.stage(&original).unwrap()).unwrap();
    let original_revisions = original.geometries.len() + original.textures.len();
    assert_eq!(domain.tracked_revisions(), original_revisions);

    let mut changed = packet();
    changed.geometries[0].vertices[0] += 0.125;
    let error = domain.stage(&manifest(&changed)).unwrap_err();
    assert!(
        error.contains("geometry")
            && error.contains(&format!("revision {}", original.geometries[0].revision)),
        "{error}"
    );

    let mut changed = packet();
    changed.textures[0].data[0] ^= 0x40;
    let error = domain.stage(&manifest(&changed)).unwrap_err();
    assert!(
        error.contains("texture")
            && error.contains(&format!("revision {}", original.textures[0].revision)),
        "{error}"
    );
    assert_eq!(
        domain.tracked_revisions(),
        original_revisions,
        "rejected candidates cannot publish"
    );
}

#[test]
fn bumped_revision_commits_and_dropped_candidate_has_no_side_effect() {
    let mut domain = SceneResourceDomain::new(12);
    let original = manifest(&packet());
    drop(domain.stage(&original).unwrap());
    assert_eq!(domain.tracked_revisions(), 0);
    domain.commit(domain.stage(&original).unwrap()).unwrap();

    let mut changed = packet();
    changed.geometries[0].revision += 1;
    changed.geometries[0].vertices[0] += 0.125;
    let update = manifest(&changed);
    domain.commit(domain.stage(&update).unwrap()).unwrap();
    assert_eq!(
        domain.tracked_revisions(),
        original.geometries.len() + original.textures.len() + 1
    );
}

#[test]
fn device_epoch_reset_rejects_stale_candidate_and_forgets_old_revisions() {
    let value = manifest(&packet());
    let mut domain = SceneResourceDomain::new(20);
    let stale = domain.stage(&value).unwrap();
    domain.reset(21);
    let error = domain.commit(stale).unwrap_err();
    assert!(
        error.contains("epoch 20") && error.contains("epoch is 21"),
        "{error}"
    );
    assert_eq!(domain.tracked_revisions(), 0);
    domain.commit(domain.stage(&value).unwrap()).unwrap();
    assert_eq!(
        domain.tracked_revisions(),
        value.geometries.len() + value.textures.len()
    );
}
