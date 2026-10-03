use super::{LayerResponseModel, MaterialLayer};

pub(super) fn validate_metal_reflection(material: &str, index: usize, layer: &MaterialLayer) -> Result<bool, String> {
    if layer.response_model != Some(LayerResponseModel::MicrofacetMetalReflection) { return Ok(false); }
    let error = |message: &str| format!("material {material} layered.layers[{index}].responseModel: {message}");
    let surface = layer.surface.as_ref();
    if surface.and_then(|s| s.metallic) != Some(1.0)
        || surface.is_some_and(|s| s.metallic_roughness_texture.is_some()) {
        return Err(error("microfacet-metal-reflection requires explicit surface.metallic=1 and no metallicRoughnessTexture."));
    }
    let params = layer.params.as_ref();
    if params.and_then(|p| p.clearcoat.as_ref()).and_then(|c| c.factor).unwrap_or(0.0) != 0.0
        || params.and_then(|p| p.transmission.as_ref()).and_then(|t| t.factor).unwrap_or(0.0) != 0.0 {
        return Err(error("microfacet-metal-reflection does not support clearcoat or transmission."));
    }
    let rotation = params.and_then(|p| p.anisotropy.as_ref()).and_then(|a| a.rotation).unwrap_or(0.0);
    if !rotation.is_finite() || rotation.abs() > std::f32::consts::PI {
        return Err(error("microfacet-metal-reflection rotation must be in [-pi, pi]."));
    }
    Ok(true)
}
