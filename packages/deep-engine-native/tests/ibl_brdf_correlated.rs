use deep_engine_native::ibl::{BUILTIN_BRDF_SIZE, builtin_default_environment};
fn integrate(nv: f64, rough: f64, correlated: bool) -> [f64; 2] {
    let mut result = [0.0; 2];
    for i in 0_u32..128 {
        let xi = [i as f64 / 128.0, i.reverse_bits() as f64 / 4294967296.0];
        let a2 = rough.powi(4);
        let hz = ((1.0 - xi[1]) / (1.0 + (a2 - 1.0) * xi[1]).max(0.00001)).sqrt();
        let hs = (1.0 - hz * hz).max(0.0).sqrt();
        let hx = (std::f64::consts::TAU * xi[0]).cos() * hs;
        let vh = ((1.0 - nv * nv).sqrt() * hx + nv * hz).max(0.0);
        let nl = (2.0 * vh * hz - nv).max(0.0);
        if nl <= 0.0 {
            continue;
        }
        let gvis = if correlated {
            let lambda =
                nl * (a2 + (1.0 - a2) * nv * nv).sqrt() + nv * (a2 + (1.0 - a2) * nl * nl).sqrt();
            2.0 * nl / lambda.max(0.000001) * vh / hz.max(0.0001)
        } else {
            let k = rough * rough / 2.0;
            nv / (nv * (1.0 - k) + k) * nl / (nl * (1.0 - k) + k) * vh / (hz * nv).max(0.0001)
        };
        let fc = (1.0 - vh).powi(5);
        result[0] += (1.0 - fc) * gvis;
        result[1] += fc * gvis;
    }
    result.map(|v| v / 128.0)
}
#[test]
fn builtin_dfg_matches_independent_correlated_smith_integration() {
    let environment = builtin_default_environment();
    assert_eq!(environment.brdf_lut.width, 32);
    assert_eq!(BUILTIN_BRDF_SIZE, 32);
    let mut old_model_gap = 0.0_f64;
    for y in [8, 16, 29] {
        for x in [2, 15, 29] {
            let nv = (x as f64 + 0.5) / 32.0;
            let rough = (y as f64 + 0.5) / 32.0;
            let expected = integrate(nv, rough, true);
            let old = integrate(nv, rough, false);
            let texel = environment.brdf_lut.texels[y * 32 + x];
            for lane in 0..2 {
                assert!(
                    (texel[lane] as f64 - expected[lane]).abs() < 2e-5,
                    "texel {x},{y} lane{lane}: {} vs {}",
                    texel[lane],
                    expected[lane]
                );
                old_model_gap = old_model_gap.max((expected[lane] - old[lane]).abs());
            }
        }
    }
    assert!(
        old_model_gap > 1e-3,
        "old Smith approximation would silently pass"
    );
}
