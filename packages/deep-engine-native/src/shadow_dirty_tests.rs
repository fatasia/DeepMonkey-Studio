use super::*;

struct Views(Vec<[[f32; 4]; 4]>);

impl ShadowViewSource for Views {
    fn cascade_count(&self) -> u32 {
        self.0.len() as u32
    }
    fn cascade_view_projection(&self, index: usize) -> [[f32; 4]; 4] {
        self.0[index]
    }
    fn shadow_map_size(&self) -> u32 {
        2_048
    }
}

fn translated(x: f32) -> PackedInstance {
    let mut instance = [0.0; deep_engine_native::scene::PACKED_INSTANCE_FLOATS];
    instance[0] = 1.0;
    instance[3] = x;
    instance[5] = 1.0;
    instance[10] = 1.0;
    instance[11] = 0.5;
    instance
}

fn identity() -> [[f32; 4]; 4] {
    [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
}

#[test]
fn only_the_cascade_containing_a_changed_caster_is_dirty() {
    let mut second = identity();
    second[3][0] = -10.0;
    let views = Views(vec![identity(), second]);
    let mut set = ShadowCasterSet {
        casters: vec![
            ShadowCaster {
                instance: translated(0.0),
                bound: [0.0, 0.0, 0.0, 0.1],
                fingerprint: 1,
            },
            ShadowCaster {
                instance: translated(10.0),
                bound: [0.0, 0.0, 0.0, 0.1],
                fingerprint: 2,
            },
        ],
        ..Default::default()
    };
    let first = set.keys(&views, 4).unwrap();
    let mut cache = ShadowDirtyCache::default();
    let initial = cache.plan(&first);
    assert_eq!(initial.dirty_mask, 0b11);
    cache.commit(&first, initial);
    assert_eq!(cache.plan(&first).reused[..2], [true, true]);

    set.casters[0].fingerprint = 3;
    set.view_keys.borrow_mut().clear(); // 模拟生产 prepare 生成新的不可变投射物集合。
    let changed = set.keys(&views, 4).unwrap();
    let evidence = cache.plan(&changed);
    assert_eq!(evidence.updated[..2], [true, false]);
    assert_eq!(evidence.reused[..2], [false, true]);

    let shader_changed = set.keys(&views, 5).unwrap();
    assert_eq!(cache.plan(&shader_changed).updated[..2], [true, true]);
}

#[test]
fn invalidate_forces_every_active_cascade_to_refresh() {
    let views = Views(vec![identity(), identity()]);
    let set = ShadowCasterSet::default();
    let keys = set.keys(&views, 0).unwrap();
    let mut cache = ShadowDirtyCache::default();
    let first = cache.plan(&keys);
    cache.commit(&keys, first);
    cache.invalidate();
    assert_eq!(cache.plan(&keys).dirty_mask, 0b11);
}

#[test]
fn authored_cast_switch_changes_cascade_keys_but_receive_and_unlit_do_not() {
    use deep_engine_native::{
        contract::{RenderPacket, ShadingModel},
        culling_contract::prepare_gpu_culling,
        lod_contract::prepare_gpu_lod,
        scene::prepare_scene,
    };
    let mut packet: RenderPacket =
        serde_json::from_str(include_str!("../fixtures/render_packet_shadow_v1.json")).unwrap();
    let prepare = |packet: &RenderPacket| {
        let scene = prepare_scene(packet).unwrap();
        ShadowCasterSet::prepare(
            packet,
            &scene,
            &prepare_gpu_culling(packet, &scene).unwrap(),
            &prepare_gpu_lod(packet, &scene).unwrap(),
        )
        .unwrap()
    };
    let views = Views(vec![identity(), identity()]);
    let initial = prepare(&packet).keys(&views, 0).unwrap();
    packet.instances[0].receive_shadow = Some(false);
    packet.materials[0].shading_model = Some(ShadingModel::Unlit);
    assert_eq!(initial, prepare(&packet).keys(&views, 0).unwrap());
    packet.instances[0].cast_shadow = Some(true);
    assert_eq!(initial, prepare(&packet).keys(&views, 0).unwrap());
    packet.instances[0].cast_shadow = Some(false);
    let changed = prepare(&packet);
    assert_eq!(changed.casters.len(), 1);
    assert_ne!(initial, changed.keys(&views, 0).unwrap());
    packet.instances[0].transform[12] = 200.0;
    assert_eq!(
        changed.keys(&views, 0).unwrap(),
        prepare(&packet).keys(&views, 0).unwrap()
    );
}

#[test]
fn shared_resource_digests_preserve_mask_uv_and_same_revision_content_invalidation() {
    let mut packet: RenderPacket =
        serde_json::from_str(include_str!("../fixtures/render_packet_textured_v1.json")).unwrap();
    let geometry_keys = |packet: &RenderPacket| {
        let geometry = &packet.geometries[0];
        let resources = HashMap::from([(geometry.id.as_str(), geometry)]);
        let mut cache = HashMap::new();
        let mut keys = Vec::new();
        // Opaque and MASK may share one resource: their UV scopes stay separate.
        for masked in [false, true, false, true] {
            let mut key = HashWriter::new(b"test");
            key.geometry(&geometry.id, &resources, masked, &mut cache)
                .unwrap();
            keys.push(key.finish());
        }
        assert_eq!(cache.len(), 1);
        assert_eq!(keys[0], keys[2]);
        assert_eq!(keys[1], keys[3]);
        keys
    };
    let initial = geometry_keys(&packet);
    packet.geometries[0].uv0.as_mut().unwrap()[0] += 0.25;
    let uv_changed = geometry_keys(&packet);
    assert_eq!(initial[0], uv_changed[0]);
    assert_ne!(initial[1], uv_changed[1]);
    packet.geometries[0].vertices[0] += 0.125;
    let position_changed = geometry_keys(&packet);
    assert_ne!(uv_changed[0], position_changed[0]);
    assert_ne!(uv_changed[1], position_changed[1]);

    let texture_key = |packet: &RenderPacket| {
        let texture = &packet.textures[0];
        let resources = HashMap::from([(texture.id.as_str(), texture)]);
        let mut cache = HashMap::new();
        let mut first = HashWriter::new(b"test");
        first.texture(&texture.id, &resources, &mut cache).unwrap();
        let mut second = HashWriter::new(b"test");
        second.texture(&texture.id, &resources, &mut cache).unwrap();
        let key = first.finish();
        assert_eq!(key, second.finish());
        assert_eq!(cache.len(), 1);
        key
    };
    let initial = texture_key(&packet);
    packet.textures[0].data[0] ^= 1;
    assert_ne!(initial, texture_key(&packet));
}
