use super::*;
use crate::runtime_package::parse_and_validate_dynamic_scene_runtime;

fn projectile_packet() -> RenderPacket {
    serde_json::from_value(serde_json::json!({
        "schema":"deep-engine.render-packet","version":1,
        "geometries":[
            {"id":"projectile-shape","revision":1,"vertices":[
                -0.05,-0.05,-0.05,0,1,0, 0.05,0.05,0.05,0,1,0, -0.05,0.05,-0.05,0,1,0
            ],"indices":[0,1,2]},
            {"id":"wall-shape","revision":1,"vertices":[
                -0.01,-1,-1,0,1,0, 0.01,1,1,0,1,0, -0.01,1,-1,0,1,0
            ],"indices":[0,1,2]}
        ],
        "materials":[{"id":"mat","baseColor":[1,1,1],"metallic":0,"roughness":1}],
        "instances":[
            {"id":"projectile-instance","geometry":"projectile-shape","material":"mat",
                "transform":[1,0,0,0,0,1,0,0,0,0,1,0,-0.6,0,0,1]},
            {"id":"wall-instance","geometry":"wall-shape","material":"mat",
                "transform":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}
        ]
    }))
    .unwrap()
}

fn run_once() -> f32 {
    let runtime = parse_and_validate_dynamic_scene_runtime(&serde_json::json!({
        "schema":"deep-engine.dynamic-runtime","schemaVersion":3,"id":"ccd-golden","revision":1,
        "physics":{"schema":"deep-engine.physics-runtime","schemaVersion":1,"enabled":true,
            "playing":true,"gravity":[0,0,0],"bodies":[
                {"id":"projectile","type":"dynamic","initialPose":{"translation":[-0.6,0,0],"rotation":[0,0,0,1]},"initialLinearVelocity":[80,0,0],
                    "mass":1,"friction":0,"restitution":0,"collider":{"kind":"render-bounds","instanceIds":["projectile-instance"]}},
                {"id":"wall","type":"fixed","initialPose":{"translation":[0,0,0],"rotation":[0,0,0,1]},
                    "mass":1,"friction":0,"restitution":0,"collider":{"kind":"render-bounds","instanceIds":["wall-instance"]}}
            ],"joints":[]}
    })).unwrap();
    let mut packet = projectile_packet();
    let mut host = NativePhysicsHost::from_runtime(&runtime, &packet)
        .unwrap()
        .unwrap();
    assert_eq!(host.advance(1.0 / 60.0, &mut packet).unwrap(), 1);
    let (step, translation) = host.instance_pose(&packet, "projectile-instance").unwrap();
    assert_eq!(step, 1);
    assert!(host.instance_pose(&packet, "wall-instance").is_none());
    translation[0]
}

#[test]
fn ccd_stops_eighty_metres_per_second_projectile_before_two_centimetre_wall() {
    let first = run_once();
    assert!(first <= -0.05, "projectile crossed the wall at x={first}");
    assert_eq!(
        run_once(),
        first,
        "same input must repeat exactly within one Rapier version"
    );
}
