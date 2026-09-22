mod args;
mod evidence;
mod gpu_info;

use std::time::Instant;

use args::RunnerArgs;
use bevy::{
    diagnostic::{FrameTimeDiagnosticsPlugin, SystemInformationDiagnosticsPlugin},
    prelude::*,
    render::{
        Render, RenderApp, RenderPlugin,
        diagnostic::RenderDiagnosticsPlugin,
        extract_resource::ExtractResourcePlugin,
        settings::{Backends, WgpuSettings},
    },
    window::{PresentMode, WindowPlugin},
};
use evidence::{RunState, sample_and_finish};
use gpu_info::{GpuInfo, capture_gpu_info};

fn main() {
    let started = Instant::now();
    let args = RunnerArgs::parse().unwrap_or_else(|error| {
        eprintln!("{error}");
        std::process::exit(2);
    });
    let mut app = App::new();
    app
        .insert_resource(RunState::new(args.clone(), started))
        .insert_resource(GpuInfo::default())
        .add_plugins(DefaultPlugins
            .set(WindowPlugin { primary_window: Some(Window { title: "Deep Engine · Bevy 0.19 reference".into(),
                resolution: (1280, 720).into(), present_mode: PresentMode::AutoNoVsync,
                visible: !args.hidden, ..default() }), ..default() })
            .set(RenderPlugin { render_creation: WgpuSettings { backends: Some(Backends::VULKAN), ..default() }.into(),
                synchronous_pipeline_compilation: true, ..default() }))
        .add_plugins((FrameTimeDiagnosticsPlugin::default(), SystemInformationDiagnosticsPlugin,
            RenderDiagnosticsPlugin, ExtractResourcePlugin::<GpuInfo>::default()))
        .add_systems(Startup, setup)
        .add_systems(Last, sample_and_finish);
    app.sub_app_mut(RenderApp).add_systems(Render, capture_gpu_info);
    app.run();
}

fn setup(mut commands: Commands, mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>, state: Res<RunState>) {
    let instance_count = state.instance_count();
    let mesh = meshes.add(Cuboid::new(0.08, 0.08, 0.08));
    let material = materials.add(StandardMaterial { base_color: Color::srgb(0.24, 0.52, 0.9),
        metallic: 0.15, perceptual_roughness: 0.42, ..default() });
    let side = (instance_count as f32).sqrt().ceil() as u32;
    let offset = (side.saturating_sub(1) as f32) * 0.055;
    for index in 0..instance_count {
        let x = (index % side) as f32 * 0.11 - offset;
        let z = (index / side) as f32 * 0.11 - offset;
        let y = ((index * 17 % 7) as f32) * 0.007;
        commands.spawn((Mesh3d(mesh.clone()), MeshMaterial3d(material.clone()), Transform::from_xyz(x, y, z)));
    }
    let light_direction = Vec3::new(0.2855, 0.8, 0.586).normalize();
    commands.spawn((DirectionalLight { illuminance: 18_000.0, shadow_maps_enabled: true, ..default() },
        Transform::IDENTITY.looking_to(light_direction, Vec3::Y)));
    let yaw = 0.55_f32;
    commands.spawn((Camera3d::default(), Msaa::Sample4,
        Projection::Perspective(PerspectiveProjection { fov: 2.0 * (1.0_f32 / 2.05).atan(), near: 0.1,
            far: 100.0, ..default() }),
        Transform::from_xyz(-4.0 * yaw.sin(), 0.0, 4.0 * yaw.cos()).looking_at(Vec3::ZERO, Vec3::Y)));
}
