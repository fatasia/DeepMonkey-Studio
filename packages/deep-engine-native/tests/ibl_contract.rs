use deep_engine_native::ibl::{
    BUILTIN_BRDF_SIZE, BUILTIN_DIFFUSE_SIZE, BUILTIN_SPECULAR_MIPS, BUILTIN_SPECULAR_SIZE,
    IblProvenance, PreparedIblEnvironment, SplitSumIblInput, builtin_default_environment,
    disabled_probe_environment, split_sum_ibl, validate_ibl_environment,
};

#[test]
fn built_in_environment_is_small_complete_hdr_and_deterministic() {
    let first = builtin_default_environment();
    let second = builtin_default_environment();
    assert_eq!(first, second);
    assert_eq!(first.id, "deep.builtin.studio-ibl.v1");
    assert_eq!(first.provenance, IblProvenance::BuiltInDefault);
    assert_eq!(first.specular.mips[0].size, BUILTIN_SPECULAR_SIZE);
    assert_eq!(first.specular.mips.len(), BUILTIN_SPECULAR_MIPS as usize);
    assert_eq!(first.diffuse.mips[0].size, BUILTIN_DIFFUSE_SIZE);
    assert_eq!(
        (first.brdf_lut.width, first.brdf_lut.height),
        (BUILTIN_BRDF_SIZE, BUILTIN_BRDF_SIZE)
    );
    let summary = validate_ibl_environment(&first).expect("valid built-in IBL");
    assert_eq!(
        (
            summary.specular_texels,
            summary.diffuse_texels,
            summary.brdf_texels
        ),
        (2_046, 384, 1_024)
    );
    assert!(all_channels(&first).all(f32::is_finite));
    assert!(all_channels(&first).any(|value| value > 1.0));
}

#[test]
fn convolution_preserves_the_studio_environment_direction_and_softens_highlights() {
    let environment = builtin_default_environment();
    let diffuse = &environment.diffuse.mips[0];
    let positive_y = face_luminance(diffuse, 2);
    let negative_y = face_luminance(diffuse, 3);
    assert!(
        positive_y > negative_y * 1.5,
        "upper hemisphere should remain brighter: +Y={positive_y}, -Y={negative_y}"
    );

    let sharp_peak = max_luminance(&environment.specular.mips[0].texels);
    let rough_peak = max_luminance(
        &environment
            .specular
            .mips
            .last()
            .expect("complete specular mip chain")
            .texels,
    );
    assert!(
        sharp_peak > rough_peak * 1.2,
        "prefiltering should reduce the peak: sharp={sharp_peak}, rough={rough_peak}"
    );
}

#[test]
fn split_sum_is_finite_and_ibl_on_moves_linear_brightness_up() {
    let enabled = split_sum_ibl(SplitSumIblInput {
        base: [0.42, 0.55, 0.68],
        metallic: 0.25,
        roughness: 0.38,
        occlusion: 0.8,
        n_dot_v: 0.71,
        irradiance: [0.18, 0.23, 0.31],
        radiance: [0.9, 0.72, 0.5],
        dfg: [0.67, 0.08],
    });
    let disabled = split_sum_ibl(SplitSumIblInput {
        base: [0.42, 0.55, 0.68],
        metallic: 0.25,
        roughness: 0.38,
        occlusion: 0.8,
        n_dot_v: 0.71,
        irradiance: [0.0; 3],
        radiance: [0.0; 3],
        dfg: [0.0; 2],
    });
    assert!(enabled.into_iter().all(f32::is_finite));
    assert!(disabled.into_iter().all(f32::is_finite));
    assert!(luminance(enabled) > luminance(disabled));
    assert_eq!(disabled, [0.0; 3]);

    for metallic in [0.0, 0.5, 1.0] {
        for roughness in [0.0, 0.06, 0.5, 1.0] {
            for occlusion in [0.0, 0.25, 1.0] {
                for n_dot_v in [0.0, 0.001, 0.5, 1.0] {
                    for dfg in [[0.0, 0.0], [0.65, 0.08], [1.0, 1.0]] {
                        let value = split_sum_ibl(SplitSumIblInput {
                            base: [0.0, 0.5, 1.0],
                            metallic,
                            roughness,
                            occlusion,
                            n_dot_v,
                            irradiance: [0.0, 0.25, 3.0],
                            radiance: [0.0, 1.0, 8.0],
                            dfg,
                        });
                        assert!(
                            value
                                .into_iter()
                                .all(|channel| channel.is_finite() && channel >= 0.0)
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn imported_hdri_uses_the_same_validated_prefilter_contract() {
    let built_in = builtin_default_environment();
    let imported = PreparedIblEnvironment::imported_hdri(
        "customer.studio.hdri",
        7,
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        built_in.specular.clone(),
        built_in.diffuse.clone(),
        built_in.brdf_lut.clone(),
    )
    .expect("prepared HDRI output should be accepted without changing the GPU contract");
    assert!(matches!(
        imported.provenance,
        IblProvenance::ImportedHdri { .. }
    ));

    let mut non_finite = imported.clone();
    non_finite.specular.mips[0].texels[0][0] = f32::NAN;
    assert!(validate_ibl_environment(&non_finite).is_err());

    let mut incomplete_mips = imported.clone();
    incomplete_mips.specular.mips.pop();
    assert!(validate_ibl_environment(&incomplete_mips).is_err());

    let mut non_square_lut = imported.clone();
    non_square_lut.brdf_lut.width = 16;
    non_square_lut.brdf_lut.texels.truncate(16 * 32);
    assert!(validate_ibl_environment(&non_square_lut).is_err());

    let invalid_hash = PreparedIblEnvironment::imported_hdri(
        "customer.invalid",
        1,
        "NOT-A-SHA256",
        built_in.specular,
        built_in.diffuse,
        built_in.brdf_lut,
    );
    assert!(invalid_hash.is_err());
}

#[test]
fn black_probe_environment_is_finite_and_zero_energy() {
    let environment = disabled_probe_environment();
    validate_ibl_environment(&environment).expect("valid disabled IBL contract");
    assert_eq!(environment.provenance, IblProvenance::DisabledProbe);
    assert!(all_channels(&environment).all(f32::is_finite));
    assert_eq!(
        all_channels(&environment)
            .filter(|value| *value != 1.0)
            .sum::<f32>(),
        0.0
    );
}

fn all_channels(environment: &PreparedIblEnvironment) -> impl Iterator<Item = f32> + '_ {
    environment
        .specular
        .mips
        .iter()
        .chain(&environment.diffuse.mips)
        .flat_map(|mip| mip.texels.iter())
        .chain(environment.brdf_lut.texels.iter())
        .flat_map(|texel| texel.iter().copied())
}

fn face_luminance(mip: &deep_engine_native::ibl::PreparedIblCubeMip, face: usize) -> f32 {
    let face_texels = (mip.size * mip.size) as usize;
    let start = face * face_texels;
    mip.texels[start..start + face_texels]
        .iter()
        .map(|texel| luminance([texel[0], texel[1], texel[2]]))
        .sum::<f32>()
        / face_texels as f32
}

fn max_luminance(texels: &[[f32; 4]]) -> f32 {
    texels
        .iter()
        .map(|texel| luminance([texel[0], texel[1], texel[2]]))
        .fold(0.0, f32::max)
}

fn luminance(rgb: [f32; 3]) -> f32 {
    rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
}
