use deep_engine_native::native_animation_controller::{
    NativeAnimationControllerCommand, NativeAnimationControllerHost,
};
use deep_engine_native::runtime_package::parse_and_validate_dynamic_scene_runtime;

use super::*;

/// 无动态通道的基础包（golden cube/triangle 实例）。
fn base_package() -> deep_engine_native::runtime_package::LoadedRuntimePackage {
    deep_engine_native::runtime_package::parse_and_validate_runtime_package(include_bytes!(
        "../tests/fixtures/runtime-package-v1.json"
    ))
    .unwrap()
}

fn controller_json(parameters: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "schema":"deep-engine.animation-controller","schemaVersion":1,
        "initialStateId":"robot:idle","activeStateId":"robot:idle","transitionDurationMs":250,
        "states":[
            {"id":"robot:idle","modelId":"robot","clipId":"Idle","loop":true},
            {"id":"robot:work","modelId":"robot","clipId":"Work Cycle","loop":true}
        ],
        "parameters":parameters,
        "transitions":[{"id":"idle-work","fromStateId":"robot:idle","toStateId":"robot:work","parameter":"advance","equals":true}]
    })
}

fn state_machine_package(
    runtime_value: serde_json::Value,
) -> deep_engine_native::runtime_package::LoadedRuntimePackage {
    let mut package = base_package();
    package.dynamic_runtime =
        Some(parse_and_validate_dynamic_scene_runtime(&runtime_value).unwrap());
    package
}

/// 与 Web 消费方 `DynamicAnimationControllerPlayer`（dynamicAnimationControllerPlayback.ts
/// 同一夹具）的同输入输出对拍：PlayClip/TransitionClip 字段逐项一致。
#[test]
fn loads_state_machine_package_into_a_started_host_matching_the_web_trail() {
    let mut content = PlayerContent::from_package(state_machine_package(serde_json::json!({
        "schema":"deep-engine.dynamic-runtime","schemaVersion":2,"id":"scene","revision":1,
        "animationController": controller_json(serde_json::json!({"advance": false}))
    })))
    .unwrap();
    let host = content.animation_controller().expect("controller host");
    assert!(host.started());
    assert_eq!(host.active_state_id(), "robot:idle");
    assert_eq!(host.commands().len(), 1);
    assert_eq!(
        host.commands()[0],
        NativeAnimationControllerCommand::PlayClip {
            state_id: "robot:idle".into(),
            model_id: "robot".into(),
            clip_id: "Idle".into(),
            r#loop: true,
        }
    );

    // 未知参数 fail-closed：不改状态、不产命令。
    assert_eq!(
        content.set_animation_controller_parameter("unknown", true),
        Ok(false)
    );
    assert_eq!(content.animation_controller().unwrap().commands().len(), 1);

    // 声明参数翻转 → 恰好一条转场，活动态推进（与 Web evaluate 相同的字段）。
    assert_eq!(
        content.set_animation_controller_parameter("advance", true),
        Ok(true)
    );
    let host = content.animation_controller().unwrap();
    assert_eq!(host.active_state_id(), "robot:work");
    assert_eq!(host.commands().len(), 2);
    assert_eq!(
        host.commands()[1],
        NativeAnimationControllerCommand::TransitionClip {
            transition_id: "idle-work".into(),
            model_id: "robot".into(),
            from_clip_id: "Idle".into(),
            to_clip_id: "Work Cycle".into(),
            duration_ms: 250,
            r#loop: true,
            next_state_id: "robot:work".into(),
        }
    );
    // 命令轨迹的 canonical 形式是跨端对拍基准（Web/Native 字符串一致）。
    assert_eq!(
        host.commands()[1].canonical(),
        "animation-controller-v1|transition|edge=idle-work|model=robot|from=Idle|to=Work Cycle|durationMs=250|loop=true|next=robot:work"
    );
    // 边已消费：同参数再次评估不再抖动，命令轨迹长度保持 2。
    assert_eq!(
        content.set_animation_controller_parameter("advance", true),
        Ok(true)
    );
    assert_eq!(content.animation_controller().unwrap().commands().len(), 2);
}

/// 包内持久参数已满足转场条件时，装载即应用首条转场（Web start→evaluate 同序）。
#[test]
fn applies_the_persisted_parameter_first_transition_at_mount() {
    let content = PlayerContent::from_package(state_machine_package(serde_json::json!({
        "schema":"deep-engine.dynamic-runtime","schemaVersion":2,"id":"scene","revision":1,
        "animationController": controller_json(serde_json::json!({"advance": true}))
    })))
    .unwrap();
    let host = content.animation_controller().unwrap();
    assert_eq!(host.active_state_id(), "robot:work");
    assert_eq!(
        host.commands(),
        &[
            NativeAnimationControllerCommand::PlayClip {
                state_id: "robot:idle".into(),
                model_id: "robot".into(),
                clip_id: "Idle".into(),
                r#loop: true,
            },
            NativeAnimationControllerCommand::TransitionClip {
                transition_id: "idle-work".into(),
                model_id: "robot".into(),
                from_clip_id: "Idle".into(),
                to_clip_id: "Work Cycle".into(),
                duration_ms: 250,
                r#loop: true,
                next_state_id: "robot:work".into(),
            },
        ]
    );
}

/// v2 场景同时携带时间线 TRS 与状态机（compileSceneRuntimePackage 合并产物）：
/// 逐帧采样推进时间线通道，canonical 帧与 Web 完全一致；状态机活动态不被帧时钟改变。
#[test]
fn plays_timeline_frames_alongside_the_controller_with_identical_canonical_frames() {
    let value = serde_json::json!({
        "schema":"deep-engine.dynamic-runtime","schemaVersion":2,"id":"scene","revision":1,
        "animation":{"schema":"deep-engine.dynamic-animation","schemaVersion":1,"durationMs":1000,"autoplay":true,"loop":true,
            "tracks":[
                {"targetId":"golden-instance","property":"translation","keyframes":[
                    {"timeMs":0,"value":[0,0,0,0,0,0,1]},{"timeMs":1000,"value":[10,2,0,0,0,0,1]}]}
            ]},
        "animationController": controller_json(serde_json::json!({"advance": false}))
    });
    let mut content = PlayerContent::from_package(state_machine_package(value)).unwrap();
    assert!(content.animation_controller().is_some());
    assert_eq!(content.dynamic_runtime_duration_ms(), Some(1000));

    let step = content.apply_dynamic_playback_step(500).unwrap();
    assert_eq!(step.time_ms, 500);
    assert_eq!(step.changed_instances, 1);
    assert_eq!(
        step.canonical,
        "dynamic-frame-v1|t=500|events=|tracks=golden-instance>translation=5.000000,1.000000,0.000000,0.000000,0.000000,0.000000,1.000000"
    );
    assert_eq!(content.packet().instances[0].transform[12], 5.0);
    // 状态机与时间线并行：帧时钟不改变活动态，命令轨迹保持 mount 时的两条。
    let host = content.animation_controller().unwrap();
    assert_eq!(host.active_state_id(), "robot:idle");
    assert_eq!(host.commands().len(), 1);
}

/// v3：物理与状态机通道共存，两个宿主都从产品装载路径创建。
#[test]
fn consumes_v3_controller_and_physics_channels_together() {
    let package = state_machine_package(serde_json::json!({
        "schema":"deep-engine.dynamic-runtime","schemaVersion":3,"id":"scene","revision":1,
        "animationController": controller_json(serde_json::json!({"advance": false})),
        "physics":{"schema":"deep-engine.physics-runtime","schemaVersion":1,"enabled":true,"playing":true,
            "gravity":[0,-9.81,0],
            "bodies":[
                {"id":"body-a","type":"dynamic","initialPose":{"translation":[0,2,0],"rotation":[0,0,0,1]},"mass":2,"friction":0.5,"restitution":0.1,"collider":{"kind":"render-bounds","instanceIds":["golden-instance"]}}
            ],
            "joints":[]
        }
    }));
    let content = PlayerContent::from_package(package).unwrap();
    assert!(content.animation_controller().is_some());
    assert!(content.physics_playing());
}

/// 无状态机场景零开销：无宿主、无命令、参数入口恒定返回 false。
#[test]
fn packages_without_a_state_machine_have_zero_controller_overhead() {
    let mut content = PlayerContent::from_package(base_package()).unwrap();
    assert!(content.animation_controller().is_none());
    assert_eq!(
        content.set_animation_controller_parameter("advance", true),
        Ok(false)
    );
    assert_eq!(content.dynamic_runtime_duration_ms(), None);
}

/// 宿主缺少配套 controller 通道时 start/evaluate fail-closed：显式错误、
/// 不产命令、不改状态（from_package 的构造不变式使装载路径无法进入该状态）。
#[test]
fn host_start_fails_closed_without_the_backing_channel() {
    let with_controller = parse_and_validate_dynamic_scene_runtime(&serde_json::json!({
        "schema":"deep-engine.dynamic-runtime","schemaVersion":2,"id":"scene","revision":1,
        "animationController": controller_json(serde_json::json!({"advance": false}))
    }))
    .unwrap();
    let bare = parse_and_validate_dynamic_scene_runtime(&serde_json::json!({
        "schema":"deep-engine.dynamic-runtime","schemaVersion":1,"id":"scene","revision":1,
        "interaction":{"schema":"deep-engine.dynamic-interaction","schemaVersion":1,"trigger":"command","action":"clear-selection","targetId":null}
    }))
    .unwrap();
    let mut host = NativeAnimationControllerHost::from_runtime(&with_controller).unwrap();
    assert!(host.start(&bare).is_err());
    assert!(!host.started());
    assert_eq!(host.commands().len(), 0);
}
