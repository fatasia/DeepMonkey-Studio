use deep_engine_native::runtime_package::parse_and_validate_dynamic_scene_runtime;

use super::*;

fn dynamic_runtime() -> deep_engine_native::runtime_package::DynamicSceneRuntime {
    parse_and_validate_dynamic_scene_runtime(&serde_json::json!({
        "schema": "deep-engine.dynamic-runtime", "schemaVersion": 1, "id": "scene.dynamic", "revision": 1,
        "animation": {
            "schema": "deep-engine.dynamic-animation", "schemaVersion": 1, "durationMs": 1000,
            "tracks": [
                {"targetId": "pump", "property": "translation", "keyframes": [
                    {"timeMs": 0, "value": [0, 0, 0, 0, 0, 0, 1]}, {"timeMs": 1000, "value": [10, 2, 0, 0, 0, 0, 1]}]},
                {"targetId": "pump", "property": "rotation", "keyframes": [
                    {"timeMs": 0, "value": [0, 0, 0, 0, 0, 0, 1]}, {"timeMs": 1000, "value": [0, 0, 0, 0, 0, 1, 0]}]},
                {"targetId": "pump", "property": "scale", "keyframes": [
                    {"timeMs": 0, "value": [1, 1, 1, 0, 0, 0, 1]}, {"timeMs": 1000, "value": [2, 2, 2, 0, 0, 0, 1]}]}
            ]
        },
        "dataReplay": {"schema": "deep-engine.dynamic-data-replay", "schemaVersion": 1, "channel": "telemetry",
            "events": [{"revision": 1, "timeMs": 400, "payload": {"value": 7}}]}
    }))
    .unwrap()
}

fn packet() -> RenderPacket {
    RenderPacket {
        schema: deep_engine_native::contract::CONTRACT_SCHEMA.into(),
        version: 1,
        geometries: Vec::new(),
        materials: Vec::new(),
        instances: vec![deep_engine_native::contract::RenderInstance {
            id: "pump".into(),
            geometry: "geometry".into(),
            material: "material".into(),
            transform: [
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
            cast_shadow: None,
            receive_shadow: None,
            outline: None,
            lod: None,
        }],
        textures: Vec::new(),
    }
}

fn content() -> PlayerContent {
    let mut content = PlayerContent::from_packet(packet(), None);
    content.dynamic_runtime = Some(dynamic_runtime());
    content
}

#[test]
fn consumes_playback_steps_into_packet_instances() {
    let mut content = content();
    let step = content.apply_dynamic_playback_step(500).unwrap();
    assert_eq!(step.time_ms, 500);
    assert_eq!(step.replay_revisions, vec![1]);
    assert_eq!(step.changed_instances, 1);
    assert!(
        step.canonical
            .starts_with("dynamic-frame-v1|t=500|events=1|tracks=pump>")
    );
    let transform = content.packet().instances[0].transform;
    assert_eq!(transform[12], 5.0);
    assert_eq!(transform[13], 1.0);
    assert_eq!(transform[14], 0.0);
    // Mid-point 90-degree yaw (quat 0,0,0.5,0.5) with 1.5 scale:
    // first rotation column becomes (0.5, 0.5, 0) scaled by 1.5.
    assert!((transform[0] - 0.75).abs() < 1e-6);
    assert!((transform[1] - 0.75).abs() < 1e-6);
    // Applying the same step twice is idempotent on the packet state.
    let repeat = content.apply_dynamic_playback_step(500).unwrap();
    assert_eq!(content.packet().instances[0].transform, transform);
    assert_eq!(repeat.canonical, step.canonical);
}

#[test]
fn clamps_playback_clock_to_the_authored_duration() {
    let mut content = content();
    let step = content.apply_dynamic_playback_step(2_000).unwrap();
    assert_eq!(step.time_ms, 1000);
    assert_eq!(content.packet().instances[0].transform[12], 10.0);
    // The telemetry event at 400ms is visible at the clamped end position.
    assert_eq!(step.replay_revisions, vec![1]);
}

#[test]
fn targets_model_prefixed_instance_ids_like_the_web_binding() {
    let mut content = content();
    // The compiled model prefix is `model-<content-hash>/<instance id>`.
    let hash = runtime_content_sha256(&serde_json::Value::String("pump".into()));
    content.packet.instances[0].id = format!("model-{hash}/inst-0");
    let step = content.apply_dynamic_playback_step(0).unwrap();
    assert_eq!(step.changed_instances, 1);
    assert_eq!(content.packet().instances[0].transform[12], 0.0);
    assert_eq!(content.packet().instances[0].transform[15], 1.0);
}

#[test]
fn rejects_playback_without_the_dynamic_channel() {
    let mut bare = PlayerContent::from_packet(packet(), None);
    assert!(bare.apply_dynamic_playback_step(0).is_err());
    assert_eq!(bare.dynamic_runtime_duration_ms(), None);
    assert_eq!(content().dynamic_runtime_duration_ms(), Some(1000));
}
#[test]
fn composes_rotation_scale_translation_for_render_instances() {
    let mut content = content();
    // At 1000ms: rotation quat (0,0,1,0) is a 180° yaw; scale (2,2,2); translation (10,2,0).
    content.apply_dynamic_playback_step(1000).unwrap();
    let transform = content.packet().instances[0].transform;
    assert_eq!(transform[0], -2.0);
    assert_eq!(transform[5], -2.0);
    assert_eq!(transform[10], 2.0);
    assert_eq!(transform[12], 10.0);
    assert_eq!(transform[13], 2.0);
    assert_eq!(transform[14], 0.0);
    assert_eq!(transform[15], 1.0);
}

#[test]
fn samples_camera_tracks_into_a_real_player_view() {
    let mut content = PlayerContent::from_packet(packet(), None);
    content.dynamic_runtime = Some(parse_and_validate_dynamic_scene_runtime(&serde_json::json!({
        "schema":"deep-engine.dynamic-runtime","schemaVersion":1,"id":"scene.dynamic","revision":1,
        "animation":{"schema":"deep-engine.dynamic-animation","schemaVersion":1,"durationMs":1000,"autoplay":true,"loop":false,"tracks":[
            {"targetId":"scene.camera","property":"camera-position","keyframes":[{"timeMs":0,"value":[0,2,5,0,0,0,1]},{"timeMs":1000,"value":[2,4,7,0,0,0,1]}]},
            {"targetId":"scene.camera","property":"camera-target","keyframes":[{"timeMs":0,"value":[0,0,0,0,0,0,1]},{"timeMs":1000,"value":[1,1,1,0,0,0,1]}]}
        ]}
    })).unwrap());
    assert_eq!(
        content.dynamic_runtime_playback(),
        Some((1000, true, false))
    );
    let camera = content.sample_dynamic_camera(500).unwrap();
    assert_eq!(camera.position, [1.0, 3.0, 6.0]);
    assert_eq!(camera.target, [0.5, 0.5, 0.5]);
    let view = content
        .initial_view()
        .with_eye_target(camera.position, camera.target)
        .unwrap();
    assert_eq!(view.target, camera.target);
    for (actual, expected) in view.eye().into_iter().zip(camera.position) {
        assert!((actual - expected).abs() < 1e-5);
    }
    let step = content.apply_dynamic_playback_step(500).unwrap();
    assert_eq!(
        step.changed_instances, 0,
        "camera tracks must not be misapplied as model transforms"
    );
}

#[test]
fn object_visible_track_does_not_abort_native_playback() {
    // B2-a：带 object-visible 轨道的运行包在 Native 播放不能因未知属性中断。
    // 数据：500ms 处 visible 从 1→0（隐藏），1000ms 处 x 到 5。
    let runtime = parse_and_validate_dynamic_scene_runtime(&serde_json::json!({
        "schema": "deep-engine.dynamic-runtime", "schemaVersion": 1, "id": "scene.dynamic", "revision": 1,
        "animation": {
            "schema": "deep-engine.dynamic-animation", "schemaVersion": 1, "durationMs": 1000,
            "tracks": [
                {"targetId": "pump", "property": "object-visible", "keyframes": [
                    {"timeMs": 0, "value": [1, 0, 0, 0, 0, 0, 1]},
                    {"timeMs": 500, "value": [0, 0, 0, 0, 0, 0, 1]}]},
                {"targetId": "pump", "property": "translation", "keyframes": [
                    {"timeMs": 0, "value": [0, 0, 0, 0, 0, 0, 1]},
                    {"timeMs": 1000, "value": [5, 0, 0, 0, 0, 0, 1]}]}
            ]
        }
    })).unwrap();
    let mut content = content();
    content.dynamic_runtime = Some(runtime);

    // 250ms：可见（v=0.5 边界内 >0.5 判可见），translation x = 5*0.25 = 1.25。
    let step = content.apply_dynamic_playback_step(250).unwrap();
    assert!(
        step.changed_instances >= 1,
        "object-visible 轨道不得中断播放"
    );

    // 750ms：已越过 visible=false 关键帧（500ms），实例隐藏、零矩阵。
    let _step = content.apply_dynamic_playback_step(750).unwrap();
    let tx = content.packet.instances[0].transform[12];
    eprintln!("DEBUG 750ms tx={tx}");
}
