//! Hardware test for production geometry/material/depth/TLAS and ordered local-light replacement.
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

fn lighting(x: f32) -> DirectionalLighting {
    let mut local = std::array::from_fn(|_| LocalLight::default());
    local[0] = LocalLight {
        kind: LocalLightKind::Point,
        position: [x, 0., 2.],
        radiance: [10.; 3],
        range: 20.,
        decay: 2.,
        cast_shadow: true,
        ..Default::default()
    };
    DirectionalLighting {
        direction: [0., 1., 0.],
        radiance: [0.; 3],
        exposure: 1.,
        shadows: false,
        global_illumination_intensity: None,
        local_lights: local,
        light_profiles: None,
    }
}

#[test]
#[ignore = "requires hardware ray query; run explicitly"]
fn megalights_actual_material_visibility_production_chain() {
    pollster::block_on(async {
        let (device, queue) = device().await;
        let mut fixture = Fixture::create(&device, &queue);
        if !device
            .features()
            .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY)
        {
            assert!(matches!(
                RtSceneResidency::build(&device, &fixture.scene),
                Err(super::rt_residency::RtResidencyReject::MissingFeature)
            ));
            let first = lighting(2.);
            let mut runtime =
                MegaLightsFrameRuntime::build(&first, MegaLightsGate::Force, None, false);
            runtime.advance(fixture.view, Some(&first), false);
            runtime.note_pending_viewport(SIZE, SIZE);
            assert!(!runtime.prepare_gpu_frame(
                &device,
                &queue,
                &fixture.targets.depth_view,
                1,
                &fixture.frame_layout,
                &fixture.material_layout,
                None,
                true
            ));
            assert!(runtime.gpu.is_none() && runtime.gbuffer.is_none());
            assert_eq!(
                runtime.gpu_reject_reason,
                Some("native_megalights_tlas_unavailable")
            );
            eprintln!(
                "MegaLights hardware leg unavailable; actual device retains clusters, no RIS allocations"
            );
            return;
        }
        let (residency, blas, tlas) = RtSceneResidency::build(&device, &fixture.scene).unwrap();
        queue.submit([blas.finish(), tlas.finish()]);
        let first = lighting(2.);
        let mut runtime = MegaLightsFrameRuntime::build(&first, MegaLightsGate::Force, None, true);
        runtime.note_pending_viewport(SIZE, SIZE);
        for (x, cast_shadow, occluded) in [(2., true, true), (-2., true, false), (2., false, false)]
        {
            let mut current = lighting(x);
            current.local_lights[0].cast_shadow = cast_shadow;
            runtime.advance(fixture.view, Some(&current), true);
            assert!(
                runtime.prepare_gpu_frame(
                    &device,
                    &queue,
                    &fixture.targets.depth_view,
                    1,
                    &fixture.frame_layout,
                    &fixture.material_layout,
                    Some(residency.tlas()),
                    true
                ),
                "{:?}",
                runtime.gpu_reject_reason
            );
            let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
            let mut encoder = device.create_command_encoder(&Default::default());
            fixture.culling.encode(&queue, &mut encoder);
            runtime.gpu.as_ref().unwrap().local_lighting(
                &queue,
                &mut encoder,
                &fixture.frame_buffer,
                1.,
                false,
            );
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
                1,
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
            assert!(
                scope.pop().await.is_none(),
                "production encoding validation"
            );
            let gpu = runtime.gpu.as_ref().unwrap();
            let surfaces = read(&device, &queue, gpu.probe_buffers()[4]);
            let colors = read(&device, &queue, gpu.probe_buffers()[2]);
            let masks = read(&device, &queue, gpu.probe_visibility());
            let center = (SIZE / 2 * SIZE + SIZE / 2) as usize;
            let surface = &surfaces[center * 12..center * 12 + 12];
            for (actual, expected) in [
                (surface[3], 0.65),
                (surface[7], 0.3),
                (surface[8], 0.12),
                (surface[9], 0.42),
                (surface[10], 0.78),
            ] {
                assert!(
                    (actual - expected).abs() < 0.005,
                    "actual GBuffer {surface:?} expected {expected}"
                );
            }
            assert!(surface[6] > 0.99, "actual geometry normal {surface:?}");
            let rgb = &colors[center * 4..center * 4 + 3];
            eprintln!(
                "surface={surface:?} color={rgb:?} visibility={}",
                masks[center]
            );
            assert_eq!(
                masks[center],
                if occluded { 0. } else { 1. },
                "winner visibility at {x}"
            );
            if occluded {
                assert!(
                    rgb.iter().all(|v| v.abs() < 0.00001),
                    "occluded surface {rgb:?}"
                );
            } else {
                assert!(
                    rgb.iter().all(|v| v.is_finite() && *v > 0.),
                    "lit surface {rgb:?}"
                );
            }
            let hdr = hdr_center(&device, &queue, &fixture.targets);
            if !occluded {
                assert!(
                    hdr[..3].iter().all(|v| *v > 0.),
                    "transparent resolve retained RIS {hdr:?}"
                );
            }
            let frame = read(&device, &queue, &fixture.frame_buffer);
            assert_eq!(
                frame[14 * 4 + 2],
                1.,
                "transparent local light count restored"
            );
            eprintln!(
                "actual GBuffer {:?}; winner visibility {}; linear RIS {:?}",
                surface, masks[center], rgb
            );
        }
        let mut fallback =
            MegaLightsFrameRuntime::build(&first, MegaLightsGate::Force, None, false);
        fallback.advance(fixture.view, Some(&first), false);
        fallback.note_pending_viewport(SIZE, SIZE);
        assert!(!fallback.prepare_gpu_frame(
            &device,
            &queue,
            &fixture.targets.depth_view,
            1,
            &fixture.frame_layout,
            &fixture.material_layout,
            None,
            true
        ));
        assert_eq!(
            fallback.gpu_reject_reason,
            Some("native_megalights_tlas_unavailable")
        );
        assert!(fallback.gpu.is_none() && fallback.gbuffer.is_none());
    });
}
