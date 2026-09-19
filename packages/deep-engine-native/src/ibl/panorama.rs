//! Offline HDR panorama prefilter; shares the built-in GGX/diffuse/DFG integrators.
use super::*;

pub struct Panorama<'a> {
    pub width: u32,
    pub height: u32,
    /// Linear RGB, row-major, +Y at the first row; azimuth atan2(z,x).
    pub rgb: &'a [[f32; 3]],
}
impl Panorama<'_> {
    pub fn validate(&self) -> Result<(), String> {
        if self.width < 2
            || self.height < 2
            || self.width > 8192
            || self.height > 4096
            || self.rgb.len() != self.width as usize * self.height as usize
            || self.rgb.len() > 8_388_608
            || self
                .rgb
                .iter()
                .flatten()
                .any(|v| !v.is_finite() || !(0.0..=65504.0).contains(v))
        {
            return Err("HDR panorama exceeds finite linear RGB shape/radiance budget".into());
        }
        Ok(())
    }
    fn sample(&self, d: [f32; 3]) -> [f32; 3] {
        let u = (d[2].atan2(d[0]) / std::f32::consts::TAU + 0.5) * self.width as f32 - 0.5;
        let v = d[1].clamp(-1.0, 1.0).acos() / std::f32::consts::PI * self.height as f32 - 0.5;
        let x = u.floor() as i32;
        let y = v.floor() as i32;
        let tx = u - u.floor();
        let ty = v - v.floor();
        let at = |x: i32, y: i32| {
            self.rgb[y.clamp(0, self.height as i32 - 1) as usize * self.width as usize
                + x.rem_euclid(self.width as i32) as usize]
        };
        let a = at(x, y);
        let b = at(x + 1, y);
        let c = at(x, y + 1);
        let e = at(x + 1, y + 1);
        std::array::from_fn(|i| {
            (a[i] * (1.0 - tx) + b[i] * tx) * (1.0 - ty) + (c[i] * (1.0 - tx) + e[i] * tx) * ty
        })
    }
}

pub fn prefilter(
    panorama: &Panorama<'_>,
    content_hash: &str,
    specular_size: u32,
) -> Result<PreparedIblEnvironment, String> {
    panorama.validate()?;
    if ![16, 64, 128, 256].contains(&specular_size) {
        return Err("unsupported HDR prefilter size".into());
    }
    let levels = specular_size.ilog2() + 1;
    let sample = |direction| panorama.sample(direction);
    let specular = PreparedIblCube {
        mips: (0..levels)
            .map(|level| {
                generate_cube(specular_size >> level, |direction| {
                    prefilter_specular_source(
                        direction,
                        level as f32 / (levels - 1) as f32,
                        128,
                        &sample,
                    )
                })
            })
            .collect(),
    };
    let diffuse = PreparedIblCube {
        mips: vec![generate_cube(32, |direction| {
            convolve_diffuse_source(direction, 128, &sample)
        })],
    };
    PreparedIblEnvironment::imported_hdri(
        "scene.environment",
        1,
        content_hash,
        specular,
        diffuse,
        generate_brdf_lut(128),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn constant_hdr_energy_survives_all_mips_without_clamping_to_ldr() {
        let pixels = vec![[4.0, 2.0, 0.5]; 8];
        let source = Panorama {
            width: 4,
            height: 2,
            rgb: &pixels,
        };
        let env = prefilter(&source, &"a".repeat(64), 16).unwrap();
        for pixel in env
            .specular
            .mips
            .iter()
            .chain(&env.diffuse.mips)
            .flat_map(|mip| &mip.texels)
        {
            assert!(
                (pixel[0] - 4.0).abs() < 1e-4
                    && (pixel[1] - 2.0).abs() < 1e-4
                    && (pixel[2] - 0.5).abs() < 1e-4
            );
        }
    }
    #[test]
    fn bilinear_seam_and_poles_stay_finite_and_invalid_data_is_rejected() {
        let pixels = vec![[0.1, 0.2, 0.3]; 8];
        let source = Panorama {
            width: 4,
            height: 2,
            rgb: &pixels,
        };
        for direction in [
            [-1.0, 0.0, 0.0],
            [-1.0, 0.0, -0.0],
            [0.0, 1.0, 0.0],
            [0.0, -1.0, 0.0],
        ] {
            assert_eq!(source.sample(direction), pixels[0]);
        }
        assert!(
            Panorama {
                width: 4,
                height: 3,
                rgb: &pixels
            }
            .validate()
            .is_err()
        );
        assert!(
            Panorama {
                width: 4,
                height: 2,
                rgb: &[[f32::NAN; 3]; 8]
            }
            .validate()
            .is_err()
        );
    }
}
