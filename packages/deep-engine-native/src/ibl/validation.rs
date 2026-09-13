use super::{
    IblProvenance, IblSummary, MAX_IBL_DIMENSION, MAX_IBL_TEXELS, PreparedIblCube,
    PreparedIblEnvironment, PreparedIblTexture2d,
};

pub fn validate_ibl_environment(value: &PreparedIblEnvironment) -> Result<IblSummary, String> {
    if value.id.is_empty() || value.revision == 0 {
        return Err("IBL id must be non-empty and revision must be positive".into());
    }
    if let IblProvenance::ImportedHdri { content_hash } = &value.provenance
        && (content_hash.len() != 64
            || !content_hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    {
        return Err("imported HDRI content hash must be lowercase SHA-256".into());
    }
    validate_cube("specular", &value.specular, true)?;
    validate_cube("diffuse", &value.diffuse, false)?;
    validate_texture_2d("BRDF LUT", &value.brdf_lut)?;
    if value.brdf_lut.width != value.brdf_lut.height {
        return Err("BRDF LUT must be square".into());
    }
    let summary = value.summary();
    if summary.specular_texels + summary.diffuse_texels + summary.brdf_texels > MAX_IBL_TEXELS {
        return Err("IBL exceeds the prepared texel budget".into());
    }
    Ok(summary)
}

fn validate_cube(label: &str, cube: &PreparedIblCube, allow_mips: bool) -> Result<(), String> {
    if cube.mips.is_empty() || (!allow_mips && cube.mips.len() != 1) {
        return Err(format!("{label} cube has an invalid mip count"));
    }
    let base = cube.mips[0].size;
    for (level, mip) in cube.mips.iter().enumerate() {
        let expected = (base >> level).max(1);
        if mip.size == 0 || mip.size > MAX_IBL_DIMENSION || mip.size != expected {
            return Err(format!("{label} cube mip {level} has invalid dimensions"));
        }
        let expected_texels = mip.size as usize * mip.size as usize * 6;
        if mip.texels.len() != expected_texels || !finite_non_negative(&mip.texels) {
            return Err(format!("{label} cube mip {level} has invalid texels"));
        }
    }
    if allow_mips && cube.mips.last().is_none_or(|mip| mip.size != 1) {
        return Err(format!(
            "{label} cube must provide a complete mip chain to 1x1"
        ));
    }
    Ok(())
}

fn validate_texture_2d(label: &str, texture: &PreparedIblTexture2d) -> Result<(), String> {
    let expected = texture.width as usize * texture.height as usize;
    if texture.width == 0
        || texture.height == 0
        || texture.width > MAX_IBL_DIMENSION
        || texture.height > MAX_IBL_DIMENSION
        || texture.texels.len() != expected
        || !finite_non_negative(&texture.texels)
    {
        return Err(format!("{label} has invalid dimensions or texels"));
    }
    Ok(())
}

fn finite_non_negative(texels: &[[f32; 4]]) -> bool {
    texels
        .iter()
        .flatten()
        .all(|value| value.is_finite() && *value >= 0.0)
}
