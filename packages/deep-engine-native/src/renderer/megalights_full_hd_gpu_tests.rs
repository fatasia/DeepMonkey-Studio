//! Full-resolution material/depth, half-resolution RIS and bounded scratch on hardware.
use super::megalights_material_fixture as fixture;
use super::{
    megalights_runtime::{MegaLightsFrameRuntime, MegaLightsGate},
    rt_residency::RtSceneResidency,
};
use deep_engine_native::{
    local_lighting::{LocalLight, LocalLightKind},
    scene_lighting::DirectionalLighting,
};
use fixture::*;

#[test]
#[ignore = "requires Vulkan ray-query hardware"]
fn megalights_full_hd_material_half_ris_production_chain() {
    pollster::block_on(async {
        let (device, queue) = device().await;
        assert!(
            device
                .features()
                .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY)
        );
        let mut fixture = Fixture::at_size(&device, &queue, 1920, 1080);
        let (residency, blas, tlas) = RtSceneResidency::build(&device, &fixture.scene).unwrap();
        queue.submit([blas.finish(), tlas.finish()]);
        let mut local = std::array::from_fn(|_| LocalLight::default());
        local[0] = LocalLight {
            kind: LocalLightKind::Point,
            position: [-2., 0., 2.],
            radiance: [10.; 3],
            range: 20.,
            decay: 2.,
            cast_shadow: true,
            ..Default::default()
        };
        let lighting = DirectionalLighting {
            direction: [0., 1., 0.],
            radiance: [0.; 3],
            exposure: 1.,
            shadows: false,
            global_illumination_intensity: None,
            local_lights: local,
            light_profiles: None,
        };
        let mut runtime =
            MegaLightsFrameRuntime::build(&lighting, MegaLightsGate::Force, None, true);
        runtime.note_pending_viewport(1920, 1080);
        runtime.advance(fixture.view, Some(&lighting), true);
        assert!(
            runtime.prepare_gpu_frame(
                &device,
                &queue,
                &fixture.targets.depth_view,
                7,
                &fixture.frame_layout,
                &fixture.material_layout,
                Some(residency.tlas()),
                true
            ),
            "{:?}",
            runtime.gpu_reject_reason
        );
        assert_eq!(runtime.gbuffer.as_ref().unwrap().dimensions, (1920, 1080));
        let gpu = runtime.gpu.as_ref().unwrap();
        assert_eq!(gpu.viewport(), (960, 540));
        assert!(gpu.matches(1920, 1080, 7, 4));
        assert!(!gpu.matches(1921, 1081, 7, 4));
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut encoder = device.create_command_encoder(&Default::default());
        fixture.culling.encode(&queue, &mut encoder);
        gpu.local_lighting(&queue, &mut encoder, &fixture.frame_buffer, 1., false);
        crate::mesh_pass::encode_opaque_pass(
            &mut encoder,
            &fixture.targets,
            &fixture.frame_group,
            &fixture.scene,
            &fixture.culling,
            None,
            &fixture.pipelines,
            true,
        );
        runtime.gbuffer.as_ref().unwrap().encode(
            &mut encoder,
            &fixture.targets.depth_view,
            &fixture.frame_group,
            &fixture.scene,
            &fixture.culling,
            None,
        );
        let projection = std::array::from_fn(|i| fixture.frame[i]);
        assert!(runtime.encode_gpu_frame(
            &device,
            &queue,
            &mut encoder,
            fixture.view,
            &projection,
            &fixture.targets.depth_view,
            7,
            &fixture.targets.hdr_view,
            Some(&fixture.targets.msaa_view),
            1.
        ));
        runtime.gpu.as_ref().unwrap().local_lighting(
            &queue,
            &mut encoder,
            &fixture.frame_buffer,
            1.,
            true,
        );
        crate::mesh_pass::encode_transparent_pass(
            &mut encoder,
            &fixture.targets,
            &fixture.frame_group,
            &fixture.scene,
            &fixture.culling,
            None,
            &fixture.pipelines,
            fixture.view.yaw,
        );
        queue.submit([encoder.finish()]);
        fixture.culling.commit_submission();
        assert!(scope.pop().await.is_none());
        let gpu = runtime.gpu.as_ref().unwrap();
        let center = 270 * 960 + 480;
        let surface = read_range(&device, &queue, gpu.probe_buffers()[4], center * 48, 48);
        let color = read_range(&device, &queue, gpu.probe_buffers()[2], center * 16, 16);
        let mask = read_range(&device, &queue, gpu.probe_visibility(), center * 4, 4);
        assert!((surface[3] - 0.65).abs() < 0.005);
        assert!((surface[9] - 0.42).abs() < 0.005);
        assert_eq!(mask[0], 1.);
        assert!(color[..3].iter().all(|v| v.is_finite() && *v > 0.));
        let hdr = hdr_pixel(&device, &queue, &fixture.targets, 960, 540);
        assert!(
            hdr[..3].iter().all(|v| *v > 0.),
            "1080p transparent resolve retained {hdr:?}"
        );
        let background = hdr_pixel(&device, &queue, &fixture.targets, 0, 0);
        let clear = fixture.targets.clear_color();
        for (actual, expected) in background[..3].iter().zip([clear.r, clear.g, clear.b]) {
            assert!(
                (f64::from(*actual) - expected).abs() < 0.005,
                "no RIS leaks across background {background:?}"
            );
        }
        let resolution = super::megalights_gpu::budget::resolution(1920, 1080).unwrap();
        eprintln!(
            "1080p actual production: GBuffer=1920x1080 RIS=960x540 resident={} bytes, surface={surface:?}, color={color:?}, mask={mask:?}",
            resolution.bytes
        );
    });
}
