mod sampling;
mod validation;

use sampling::{add, basis, cube_direction, dot, ggx, mul, reflect, studio};
pub use validation::validate_ibl_environment;

pub const BUILTIN_SPECULAR_SIZE: u32 = 16;
pub const BUILTIN_SPECULAR_MIPS: u32 = 5;
pub const BUILTIN_DIFFUSE_SIZE: u32 = 8;
pub const BUILTIN_BRDF_SIZE: u32 = 32;
const ENVIRONMENT_SAMPLES: u32 = 64;
const BRDF_SAMPLES: u32 = 128;
const MAX_IBL_DIMENSION: u32 = 4_096;
const MAX_IBL_TEXELS: usize = 100_000_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IblProvenance {
    BuiltInDefault,
    DisabledProbe,
    ImportedHdri { content_hash: String },
}

#[derive(Clone, Debug, PartialEq)]
pub struct PreparedIblEnvironment {
    pub id: String,
    pub revision: u32,
    pub provenance: IblProvenance,
    pub specular: PreparedIblCube,
    pub diffuse: PreparedIblCube,
    pub brdf_lut: PreparedIblTexture2d,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PreparedIblCube {
    pub mips: Vec<PreparedIblCubeMip>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PreparedIblCubeMip {
    pub size: u32,
    /// Face-major rgba32f texels in WebGPU cube order: +X, -X, +Y, -Y, +Z, -Z.
    pub texels: Vec<[f32; 4]>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PreparedIblTexture2d {
    pub width: u32,
    pub height: u32,
    pub texels: Vec<[f32; 4]>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IblSummary {
    pub specular_mips: usize,
    pub specular_texels: usize,
    pub diffuse_texels: usize,
    pub brdf_texels: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SplitSumIblInput {
    pub base: [f32; 3],
    pub metallic: f32,
    pub roughness: f32,
    pub occlusion: f32,
    pub n_dot_v: f32,
    pub irradiance: [f32; 3],
    pub radiance: [f32; 3],
    pub dfg: [f32; 2],
}

impl PreparedIblEnvironment {
    /// Accepts output from a future HDRI decoder/prefilterer through the same validated contract.
    pub fn imported_hdri(
        id: impl Into<String>,
        revision: u32,
        content_hash: impl Into<String>,
        specular: PreparedIblCube,
        diffuse: PreparedIblCube,
        brdf_lut: PreparedIblTexture2d,
    ) -> Result<Self, String> {
        let environment = Self {
            id: id.into(),
            revision,
            provenance: IblProvenance::ImportedHdri {
                content_hash: content_hash.into(),
            },
            specular,
            diffuse,
            brdf_lut,
        };
        validate_ibl_environment(&environment)?;
        Ok(environment)
    }

    pub fn summary(&self) -> IblSummary {
        IblSummary {
            specular_mips: self.specular.mips.len(),
            specular_texels: self.specular.mips.iter().map(|mip| mip.texels.len()).sum(),
            diffuse_texels: self.diffuse.mips.iter().map(|mip| mip.texels.len()).sum(),
            brdf_texels: self.brdf_lut.texels.len(),
        }
    }
}

pub fn builtin_default_environment() -> PreparedIblEnvironment {
    let specular = PreparedIblCube {
        mips: (0..BUILTIN_SPECULAR_MIPS)
            .map(|level| {
                let size = (BUILTIN_SPECULAR_SIZE >> level).max(1);
                let roughness = level as f32 / (BUILTIN_SPECULAR_MIPS - 1) as f32;
                generate_cube(size, |direction| prefilter_specular(direction, roughness))
            })
            .collect(),
    };
    let diffuse = PreparedIblCube {
        mips: vec![generate_cube(BUILTIN_DIFFUSE_SIZE, convolve_diffuse)],
    };
    let brdf_lut = generate_brdf_lut(BUILTIN_BRDF_SIZE);
    let result = PreparedIblEnvironment {
        id: "deep.builtin.studio-ibl.v1".into(),
        revision: 1,
        provenance: IblProvenance::BuiltInDefault,
        specular,
        diffuse,
        brdf_lut,
    };
    validate_ibl_environment(&result).expect("built-in IBL must satisfy its contract");
    result
}

pub fn disabled_probe_environment() -> PreparedIblEnvironment {
    let black_cube = || PreparedIblCube {
        mips: vec![PreparedIblCubeMip {
            size: 1,
            texels: vec![[0.0, 0.0, 0.0, 1.0]; 6],
        }],
    };
    PreparedIblEnvironment {
        id: "deep.probe.ibl-disabled".into(),
        revision: 1,
        provenance: IblProvenance::DisabledProbe,
        specular: black_cube(),
        diffuse: black_cube(),
        brdf_lut: PreparedIblTexture2d {
            width: 1,
            height: 1,
            texels: vec![[0.0, 0.0, 0.0, 1.0]],
        },
    }
}

pub fn split_sum_ibl(input: SplitSumIblInput) -> [f32; 3] {
    let SplitSumIblInput {
        base,
        metallic,
        roughness,
        occlusion,
        n_dot_v,
        irradiance,
        radiance,
        dfg,
    } = input;
    let metal = metallic.clamp(0.0, 1.0);
    let rough = roughness.clamp(0.06, 1.0);
    let ao = occlusion.clamp(0.0, 1.0);
    let nv = n_dot_v.clamp(0.001, 1.0);
    let mut result = [0.0; 3];
    for channel in 0..3 {
        let f0 = 0.04 + (base[channel] - 0.04) * metal;
        let f90 = (1.0 - rough).max(f0);
        let fresnel = f0 + (f90 - f0) * (1.0 - nv).powi(5);
        let diffuse = (1.0 - fresnel) * (1.0 - metal) * base[channel] * irradiance[channel];
        let energy = 1.0 + f0 * (1.0 / (dfg[0] + dfg[1]).max(0.05) - 1.0);
        let specular = radiance[channel] * (f0 * dfg[0] + dfg[1]) * energy;
        result[channel] = (diffuse + specular) * ao;
    }
    result
}

fn generate_cube(size: u32, sample: impl Fn([f32; 3]) -> [f32; 3]) -> PreparedIblCubeMip {
    let mut texels = Vec::with_capacity(size as usize * size as usize * 6);
    for face in 0..6 {
        for y in 0..size {
            for x in 0..size {
                let direction = cube_direction(face, x, y, size);
                let color = sample(direction);
                texels.push([color[0], color[1], color[2], 1.0]);
            }
        }
    }
    PreparedIblCubeMip { size, texels }
}

fn convolve_diffuse(normal: [f32; 3]) -> [f32; 3] {
    let mut color = [0.0; 3];
    for index in 0..ENVIRONMENT_SAMPLES {
        let xi = sampling::hammersley(index, ENVIRONMENT_SAMPLES);
        let radius = xi[1].sqrt();
        let local = [
            (std::f32::consts::TAU * xi[0]).cos() * radius,
            (std::f32::consts::TAU * xi[0]).sin() * radius,
            (1.0 - xi[1]).sqrt(),
        ];
        color = add(color, studio(basis(normal, local)));
    }
    mul(color, 1.0 / ENVIRONMENT_SAMPLES as f32)
}

fn prefilter_specular(normal: [f32; 3], roughness: f32) -> [f32; 3] {
    if roughness < 0.001 {
        return studio(normal);
    }
    let mut color = [0.0; 3];
    let mut weight = 0.0;
    for index in 0..ENVIRONMENT_SAMPLES {
        let half = basis(
            normal,
            ggx(sampling::hammersley(index, ENVIRONMENT_SAMPLES), roughness),
        );
        let light = reflect(mul(normal, -1.0), half);
        let cosine = dot(normal, light).max(0.0);
        color = add(color, mul(studio(light), cosine));
        weight += cosine;
    }
    mul(color, 1.0 / weight.max(0.0001))
}

fn generate_brdf_lut(size: u32) -> PreparedIblTexture2d {
    let mut texels = Vec::with_capacity((size * size) as usize);
    for y in 0..size {
        let roughness = (y as f32 + 0.5) / size as f32;
        for x in 0..size {
            let nv = ((x as f32 + 0.5) / size as f32).max(0.001);
            let view = [(1.0 - nv * nv).sqrt(), 0.0, nv];
            let mut result = [0.0; 2];
            for index in 0..BRDF_SAMPLES {
                let half = ggx(sampling::hammersley(index, BRDF_SAMPLES), roughness);
                let light = reflect(mul(view, -1.0), half);
                let nl = light[2].max(0.0);
                let nh = half[2].max(0.0);
                let vh = dot(view, half).max(0.0);
                if nl > 0.0 {
                    let k = roughness * roughness / 2.0;
                    let geometry = (nv / (nv * (1.0 - k) + k)) * (nl / (nl * (1.0 - k) + k));
                    let visibility = geometry * vh / (nh * nv).max(0.0001);
                    let fresnel = (1.0 - vh).powi(5);
                    result[0] += (1.0 - fresnel) * visibility;
                    result[1] += fresnel * visibility;
                }
            }
            texels.push([
                result[0] / BRDF_SAMPLES as f32,
                result[1] / BRDF_SAMPLES as f32,
                0.0,
                1.0,
            ]);
        }
    }
    PreparedIblTexture2d {
        width: size,
        height: size,
        texels,
    }
}
