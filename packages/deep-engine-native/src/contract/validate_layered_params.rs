use super::{LayerMaterialParams, LayeredMaterial};

fn error(material: &str, layer: Option<usize>, field: &str, message: &str) -> String {
    let path = match layer {
        Some(index) => format!("layered.layers[{index}].params.{field}"),
        None => format!("layered.base.{field}"),
    };
    format!("material {material} {path}: {message}")
}

fn unit(value: f32) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}

fn validate_parameters(
    material: &str,
    layer: Option<usize>,
    params: &LayerMaterialParams,
) -> Result<(), String> {
    if params
        .ior
        .is_some_and(|value| !value.is_finite() || value < 1.0)
    {
        return Err(error(
            material,
            layer,
            "ior",
            "Material IOR must be a finite float32 value at least 1.",
        ));
    }
    let coat = params.clearcoat.as_ref();
    let aniso = params.anisotropy.as_ref();
    for (field, value, message) in [
        (
            "clearcoat.factor",
            coat.and_then(|value| value.factor),
            "Clearcoat factor must be in 0..1.",
        ),
        (
            "clearcoat.roughness",
            coat.and_then(|value| value.roughness),
            "Clearcoat roughness must be in 0..1.",
        ),
        (
            "anisotropy.strength",
            aniso.and_then(|value| value.strength),
            "Anisotropy strength must be in 0..1.",
        ),
        (
            "transmission.factor",
            params.transmission.as_ref().and_then(|value| value.factor),
            "Transmission factor must be in 0..1.",
        ),
    ] {
        if value.is_some_and(|value| !unit(value)) {
            return Err(error(material, layer, field, message));
        }
    }
    if aniso
        .and_then(|value| value.rotation)
        .is_some_and(|value| !value.is_finite())
    {
        return Err(error(
            material,
            layer,
            "anisotropy.rotation",
            "Anisotropy rotation must be a finite number of radians.",
        ));
    }
    Ok(())
}

fn validate_supported(
    material: &str,
    layer: Option<usize>,
    params: &LayerMaterialParams,
) -> Result<(), String> {
    for (field, value) in [
        (
            "clearcoat.factor",
            params.clearcoat.as_ref().and_then(|value| value.factor),
        ),
        (
            "anisotropy.strength",
            params.anisotropy.as_ref().and_then(|value| value.strength),
        ),
        (
            "transmission.factor",
            params.transmission.as_ref().and_then(|value| value.factor),
        ),
    ] {
        if value.is_some_and(|value| value != 0.0)
            && !(layer.is_some() && field == "clearcoat.factor")
        {
            return Err(error(
                material,
                layer,
                field,
                &format!("Native layered materials do not support nonzero {field}."),
            ));
        }
    }
    Ok(())
}

/// Validate every declared parameter, then reject only unsupported active responses.
/// The coverage default and IOR default match the existing TS/Native layer family.
pub(super) fn validate_layered_params(
    material: &str,
    material_ior: Option<f32>,
    layered: &LayeredMaterial,
) -> Result<(), String> {
    if let Some(base) = &layered.base {
        validate_parameters(material, None, base)?;
    }
    for (index, layer) in layered.layers.iter().enumerate() {
        if let Some(params) = &layer.params {
            validate_parameters(material, Some(index), params)?;
        }
    }
    if layered
        .layers
        .iter()
        .any(|layer| layer.coverage.unwrap_or(0.0) > 0.0)
    {
        let base_ior = layered
            .base
            .as_ref()
            .and_then(|base| base.ior)
            .unwrap_or(1.5);
        if base_ior != material_ior.unwrap_or(1.5) {
            return Err(error(
                material,
                None,
                "ior",
                "Layer base IOR must match the material instance IOR field.",
            ));
        }
        if let Some(base) = &layered.base {
            validate_supported(material, None, base)?;
        }
    }
    for (index, layer) in layered.layers.iter().enumerate() {
        if layer.coverage.unwrap_or(0.0) > 0.0 {
            if super::validate_metal_reflection::validate_metal_reflection(material, index, layer)? { continue; }
            if let Some(params) = &layer.params {
                validate_supported(material, Some(index), params)?;
            }
        }
    }
    Ok(())
}
