//! [`crate::sdf_gi_probe_update`] 单元测试:白炉稳定性/SH 投影/埋入透传/bounce 哨兵/
//! 命中统计/窗口计划/记录初值/参数包布局。

use super::*;

fn directions_16() -> Vec<[f64; 3]> {
    (0..16)
        .map(|ordinal| crate::sdf_gi_trace::probe_occlusion_direction(ordinal, 16))
        .collect()
}

#[test]
fn white_furnace_uniform_sky_stays_bitwise_stable() {
    let directions = directions_16();
    // 全开可见度 + 均匀天空(2 的幂和,顺序累加精确):target ≡ E。
    let visibilities = vec![1.0f32; 16];
    let first = update_probe_sh_with_sdf_gi(&ProbeShUpdateInput {
        previous: &[None],
        directions: &directions,
        visibilities: &visibilities,
        direction_sky_radiance: &[[0.5, 0.25, 0.75]; 16],
        ssgdi: &[],
        bounce_albedo: None,
        alpha: Some(0.1),
        geometry_stats: Some(&[(10.0, 1.0)]),
    });
    let record = &first.records[0];
    assert_eq!(
        record.irradiance,
        [0.5f32, 0.25, 0.75],
        "全开 × 均匀天空 = ×1.0(逐位)"
    );
    assert_eq!(record.occlusion_floor, 1.0);
    // 稳态:prev ≡ target 在任意 α 下逐位不动(lerp 不动点)。
    let previous = ProbeShPreviousRecord {
        irradiance: [0.5, 0.25, 0.75],
        validity: 1.0,
        mean_distance: 10.0,
        distance_variance: 1.0,
        occlusion_floor: 1.0,
        position_offset: [0.0; 3],
    };
    for alpha in [0.01, 0.1, 0.5, 1.0] {
        let steady = update_probe_sh_with_sdf_gi(&ProbeShUpdateInput {
            previous: &[Some(previous)],
            directions: &directions,
            visibilities: &visibilities,
            direction_sky_radiance: &[[0.5, 0.25, 0.75]; 16],
            ssgdi: &[],
            bounce_albedo: None,
            alpha: Some(alpha),
            geometry_stats: Some(&[(10.0, 1.0)]),
        });
        assert_eq!(
            steady.records[0].irradiance,
            [0.5f32, 0.25, 0.75],
            "α={alpha}"
        );
    }
}

#[test]
fn uniform_visibility_projects_exact_zero_dipoles() {
    let directions = directions_16();
    let sh = project_sky_visibility_sh(&[0.25; 16], &directions);
    assert_eq!(sh[0], 0.25);
    assert_eq!(sh[1], 0.0);
    assert_eq!(sh[2], 0.0);
    assert_eq!(sh[3], 0.0);
    // 重建 ≡ 0.25(白炉构造性保证)。
    for direction in &directions {
        assert_eq!(evaluate_sky_visibility_sh(&sh, *direction), 0.25);
    }
}

#[test]
fn temporal_lerp_blends_toward_target() {
    let directions = directions_16();
    let visibilities = vec![1.0f32; 16];
    let previous = ProbeShPreviousRecord {
        irradiance: [0.0, 0.0, 0.0],
        validity: 1.0,
        mean_distance: 5.0,
        distance_variance: 0.5,
        occlusion_floor: 1.0,
        position_offset: [0.1, 0.2, 0.3],
    };
    let result = update_probe_sh_with_sdf_gi(&ProbeShUpdateInput {
        previous: &[Some(previous)],
        directions: &directions,
        visibilities: &visibilities,
        direction_sky_radiance: &[[1.0, 0.0, 0.0]; 16],
        ssgdi: &[],
        bounce_albedo: None,
        alpha: Some(0.25),
        geometry_stats: None,
    });
    // out = prev + (target − prev)·α = 0 + 1×0.25。
    assert_eq!(result.records[0].irradiance, [0.25f32, 0.0, 0.0]);
    // 无 stats → 沿用 previous。
    assert_eq!(result.records[0].mean_distance, 5.0);
    assert_eq!(result.records[0].distance_variance, 0.5);
    assert_eq!(result.alpha, 0.25);
}

#[test]
fn buried_probe_is_passthrough_and_gets_no_sh() {
    let directions = directions_16();
    let previous = ProbeShPreviousRecord {
        irradiance: [0.3, 0.2, 0.1],
        validity: 0.0,
        mean_distance: 0.4,
        distance_variance: 0.09,
        occlusion_floor: 0.5,
        position_offset: [0.01, 0.02, 0.03],
    };
    let result = update_probe_sh_with_sdf_gi(&ProbeShUpdateInput {
        previous: &[Some(previous)],
        directions: &directions,
        visibilities: &[0.0f32; 16],
        direction_sky_radiance: &[[1.0, 1.0, 1.0]; 16],
        ssgdi: &[],
        bounce_albedo: Some([1.0, 1.0, 1.0]),
        alpha: Some(1.0),
        geometry_stats: Some(&[(9.0, 9.0)]),
    });
    let record = &result.records[0];
    // 原样透传(泄露哨兵):墙内探针不被天光场复活,几何/位置字段保留。
    assert_eq!(record.irradiance, [0.3f32, 0.2, 0.1]);
    assert_eq!(record.validity, 0.0);
    assert_eq!(record.mean_distance, 0.4);
    assert_eq!(record.distance_variance, 0.09);
    assert_eq!(record.occlusion_floor, 0.5);
    assert_eq!(record.position_offset, [0.01f32, 0.02, 0.03]);
    assert_eq!(result.sky_visibility_sh[0], None);
}

#[test]
fn bounce_scales_and_sentinel_fails_closed() {
    let directions = directions_16();
    let visibilities = vec![1.0f32; 16];
    // 反照率 1 → ×2,恰在上界内不触发。
    let result = update_probe_sh_with_sdf_gi(&ProbeShUpdateInput {
        previous: &[None],
        directions: &directions,
        visibilities: &visibilities,
        direction_sky_radiance: &[[0.5, 0.0, 0.0]; 16],
        ssgdi: &[],
        bounce_albedo: Some([1.0, 0.5, 0.0]),
        alpha: None,
        geometry_stats: None,
    });
    assert_eq!(result.bounce_sentinel_trips, 0);
    assert_eq!(result.records[0].irradiance, [1.0f32, 0.0, 0.0]);
    // α 缺省回 0.1;首帧直取 target(bounce 后)。
    assert_eq!(result.alpha, 0.1);
}

#[test]
fn bounce_albedo_contract_is_fail_fast() {
    let directions = directions_16();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        update_probe_sh_with_sdf_gi(&ProbeShUpdateInput {
            previous: &[None],
            directions: &directions,
            visibilities: &[1.0f32; 16],
            direction_sky_radiance: &[[1.0, 1.0, 1.0]; 16],
            ssgdi: &[],
            bounce_albedo: Some([1.5, 0.0, 0.0]),
            alpha: None,
            geometry_stats: None,
        })
    }));
    assert!(
        result.is_err(),
        "反照率越界必须 fail-fast(TS RangeError 同义)"
    );
}

#[test]
fn ssgdi_adds_per_probe() {
    let directions = directions_16();
    let result = update_probe_sh_with_sdf_gi(&ProbeShUpdateInput {
        previous: &[None, None],
        directions: &directions,
        visibilities: &[1.0f32; 32],
        direction_sky_radiance: &[[1.0, 0.0, 0.0]; 16],
        ssgdi: &[None, Some([0.5, 0.25, 0.125])],
        bounce_albedo: None,
        alpha: None,
        geometry_stats: None,
    });
    assert_eq!(result.records[0].irradiance, [1.0f32, 0.0, 0.0]);
    assert_eq!(result.records[1].irradiance, [1.5f32, 0.25, 0.125]);
}

#[test]
fn geometry_stats_reduce_mean_and_population_variance() {
    let hits = [1.0f32, 3.0, -1.0, -1.0];
    let stats = sdf_gi_probe_geometry_stats(&hits, 2, 100.0);
    // 探针 0:命中 [1,3] → mean 2,var = ((−1)²+1²)/2 = 1。
    assert_eq!(stats[0], (2.0, 1.0));
    // 探针 1:全 miss → (maxDistance, 0)(开放空间语义)。
    assert_eq!(stats[1], (100.0, 0.0));
}

#[test]
fn probe_window_cycles_without_repeat() {
    assert_eq!(plan_sdf_gi_probe_window(0, 64.0, 0), (0, 0));
    assert_eq!(plan_sdf_gi_probe_window(10, 0.0, 0), (0, 0));
    assert_eq!(plan_sdf_gi_probe_window(10, 4.0, 0), (0, 4));
    assert_eq!(plan_sdf_gi_probe_window(10, 4.0, 1), (4, 4));
    assert_eq!(plan_sdf_gi_probe_window(10, 4.0, 2), (8, 2), "触底钳制");
    assert_eq!(plan_sdf_gi_probe_window(10, 4.0, 3), (2, 4), "回绕不重复");
    assert_eq!(
        plan_sdf_gi_probe_window(10, 99.0, 0),
        (0, 10),
        "预算钳 probeCount"
    );
}

#[test]
fn initial_records_carry_bounded_chebyshev_prior() {
    let records = pack_initial_sdf_gi_records(3, 8.0);
    assert_eq!(records.len(), 3);
    let record = crate::probe_gi_abi::pack_records(&records).unwrap();
    assert_eq!(record.len(), 3 * crate::probe_gi_abi::PROBE_GI_RECORD_BYTES);
    for record in &records {
        assert_eq!(record.validity, 1.0);
        assert_eq!(record.irradiance, [0.0; 3]);
        assert_eq!(record.mean_distance, 4.0);
        assert_eq!(record.distance_variance, 4.0, "(maxDistance/4)² = 4");
        assert_eq!(record.reserved, [0.0; 12]);
        record.validate().unwrap();
    }
}

#[test]
fn update_params_pack_matches_wgsl_struct() {
    let directions = directions_16();
    let input = ProbeShUpdateInput {
        previous: &[None; 40],
        directions: &directions,
        visibilities: &[1.0f32; 640],
        direction_sky_radiance: &[[0.5, 0.5, 0.5]; 16],
        ssgdi: &[],
        bounce_albedo: Some([0.5, 0.4, 0.3]),
        alpha: Some(0.2),
        geometry_stats: None,
    };
    let params = SdfGiProbeUpdateParams::pack(&input, 8, 32, 42.0);
    assert_eq!(
        size_of::<SdfGiProbeUpdateParams>(),
        SDF_GI_PROBE_UPDATE_PARAMS_BYTES
    );
    assert_eq!(params.probe_count, 40);
    assert_eq!(params.direction_count, 16);
    assert_eq!(params.window_offset, 8);
    assert_eq!(params.window_count, 32);
    assert_eq!(params.alpha, 0.2);
    assert_eq!(params.bounce_enabled, 1);
    assert_eq!(params.record_vec4_stride, 6);
    assert_eq!(params.bounce_energy_limit, 2.01);
    assert_eq!(params.bounce_albedo, [0.5f32, 0.4, 0.3, 0.0]);
    assert_eq!(params.max_distance, 42.0);
    // 无 bounce → 开关 0、albedo 零填充。
    let mut plain = input;
    plain.bounce_albedo = None;
    let params = SdfGiProbeUpdateParams::pack(&plain, 0, 0, 42.0);
    assert_eq!(params.bounce_enabled, 0);
    assert_eq!(params.bounce_albedo, [0.0; 4]);
}

#[test]
fn alpha_resolution_fails_closed_to_default() {
    assert_eq!(resolve_deep_gi_temporal_alpha(None), 0.1);
    assert_eq!(resolve_deep_gi_temporal_alpha(Some(0.5)), 0.5);
    assert_eq!(resolve_deep_gi_temporal_alpha(Some(f64::NAN)), 0.1);
    assert_eq!(resolve_deep_gi_temporal_alpha(Some(0.001)), 0.1);
    assert_eq!(resolve_deep_gi_temporal_alpha(Some(1.5)), 0.1);
}
