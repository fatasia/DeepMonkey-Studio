use std::num::NonZeroU64;

use super::{
    ShaderAbiBindGroupLayout, ShaderAbiBindingResource, ShaderAbiBlendComponent,
    ShaderAbiBlendState, ShaderAbiColorAttachment, ShaderAbiRasterMode, ShaderAbiVertexStream,
};

pub(super) fn bind_group_entries(
    layout: &ShaderAbiBindGroupLayout,
) -> Result<Vec<wgpu::BindGroupLayoutEntry>, String> {
    layout.bindings.iter().map(binding_entry).collect()
}

fn binding_entry(binding: &super::ShaderAbiBinding) -> Result<wgpu::BindGroupLayoutEntry, String> {
    let visibility = binding.visibility.iter().try_fold(
        wgpu::ShaderStages::empty(),
        |stages, value| match value.as_str() {
            "vertex" => Ok(stages | wgpu::ShaderStages::VERTEX),
            "fragment" => Ok(stages | wgpu::ShaderStages::FRAGMENT),
            other => Err(format!("unsupported shader visibility {other}")),
        },
    )?;
    let ty = match &binding.resource {
        ShaderAbiBindingResource::UniformBuffer {
            min_binding_size, ..
        } => wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: NonZeroU64::new(u64::from(*min_binding_size)),
        },
        ShaderAbiBindingResource::Texture {
            sample_type,
            view_dimension,
            multisampled,
        } => wgpu::BindingType::Texture {
            sample_type: match sample_type.as_str() {
                "depth" => wgpu::TextureSampleType::Depth,
                "float" => wgpu::TextureSampleType::Float { filterable: true },
                other => return Err(format!("unsupported texture sample type {other}")),
            },
            view_dimension: match view_dimension.as_str() {
                "2d" => wgpu::TextureViewDimension::D2,
                "2d-array" => wgpu::TextureViewDimension::D2Array,
                "cube" => wgpu::TextureViewDimension::Cube,
                other => return Err(format!("unsupported texture view dimension {other}")),
            },
            multisampled: *multisampled,
        },
        ShaderAbiBindingResource::Sampler { sampler_type } => {
            wgpu::BindingType::Sampler(match sampler_type.as_str() {
                "filtering" => wgpu::SamplerBindingType::Filtering,
                "comparison" => wgpu::SamplerBindingType::Comparison,
                other => return Err(format!("unsupported sampler type {other}")),
            })
        }
    };
    Ok(wgpu::BindGroupLayoutEntry {
        binding: binding.binding,
        visibility,
        ty,
        count: None,
    })
}

pub(super) fn vertex_buffers(
    streams: &[ShaderAbiVertexStream],
) -> Result<Vec<Option<OwnedVertexBufferLayout>>, String> {
    let highest = streams
        .iter()
        .map(|stream| stream.slot)
        .max()
        .ok_or("shader package pass has no vertex streams")?;
    let mut result = vec![None; highest as usize + 1];
    for stream in streams {
        let slot = stream.slot as usize;
        if result[slot].is_some() {
            return Err(format!("duplicate vertex stream slot {}", stream.slot));
        }
        let attributes = stream
            .attributes
            .iter()
            .map(|attribute| {
                Ok(wgpu::VertexAttribute {
                    format: vertex_format(&attribute.format)?,
                    offset: u64::from(attribute.byte_offset),
                    shader_location: attribute.shader_location,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        result[slot] = Some(OwnedVertexBufferLayout {
            array_stride: u64::from(stream.array_stride),
            step_mode: match stream.step_mode.as_str() {
                "vertex" => wgpu::VertexStepMode::Vertex,
                "instance" => wgpu::VertexStepMode::Instance,
                other => return Err(format!("unsupported vertex step mode {other}")),
            },
            attributes,
        });
    }
    Ok(result)
}

#[derive(Debug, Clone)]
pub(super) struct OwnedVertexBufferLayout {
    pub array_stride: wgpu::BufferAddress,
    pub step_mode: wgpu::VertexStepMode,
    pub attributes: Vec<wgpu::VertexAttribute>,
}

impl OwnedVertexBufferLayout {
    pub fn borrowed(&self) -> wgpu::VertexBufferLayout<'_> {
        wgpu::VertexBufferLayout {
            array_stride: self.array_stride,
            step_mode: self.step_mode,
            attributes: &self.attributes,
        }
    }
}

fn vertex_format(value: &str) -> Result<wgpu::VertexFormat, String> {
    match value {
        "float32" => Ok(wgpu::VertexFormat::Float32),
        "float32x2" => Ok(wgpu::VertexFormat::Float32x2),
        "float32x3" => Ok(wgpu::VertexFormat::Float32x3),
        "float32x4" => Ok(wgpu::VertexFormat::Float32x4),
        other => Err(format!("unsupported vertex format {other}")),
    }
}

pub(super) fn color_target(
    attachment: &ShaderAbiColorAttachment,
) -> Result<wgpu::ColorTargetState, String> {
    Ok(wgpu::ColorTargetState {
        format: texture_format(&attachment.format)?,
        blend: attachment.blend.as_ref().map(blend_state).transpose()?,
        write_mask: match attachment.write_mask.as_str() {
            "all" => wgpu::ColorWrites::ALL,
            other => return Err(format!("unsupported color write mask {other}")),
        },
    })
}

fn blend_state(value: &ShaderAbiBlendState) -> Result<wgpu::BlendState, String> {
    Ok(wgpu::BlendState {
        color: blend_component(&value.color)?,
        alpha: blend_component(&value.alpha)?,
    })
}

fn blend_component(value: &ShaderAbiBlendComponent) -> Result<wgpu::BlendComponent, String> {
    Ok(wgpu::BlendComponent {
        src_factor: blend_factor(&value.src_factor)?,
        dst_factor: blend_factor(&value.dst_factor)?,
        operation: match value.operation.as_str() {
            "add" => wgpu::BlendOperation::Add,
            other => return Err(format!("unsupported blend operation {other}")),
        },
    })
}

fn blend_factor(value: &str) -> Result<wgpu::BlendFactor, String> {
    match value {
        "one" => Ok(wgpu::BlendFactor::One),
        "src-alpha" => Ok(wgpu::BlendFactor::SrcAlpha),
        "one-minus-src-alpha" => Ok(wgpu::BlendFactor::OneMinusSrcAlpha),
        other => Err(format!("unsupported blend factor {other}")),
    }
}

pub(super) fn texture_format(value: &str) -> Result<wgpu::TextureFormat, String> {
    match value {
        "rgba16float" => Ok(wgpu::TextureFormat::Rgba16Float),
        "depth24plus" => Ok(wgpu::TextureFormat::Depth24Plus),
        "depth32float" => Ok(wgpu::TextureFormat::Depth32Float),
        other => Err(format!("unsupported attachment format {other}")),
    }
}

pub(super) fn compare_function(value: &str) -> Result<wgpu::CompareFunction, String> {
    match value {
        "less" => Ok(wgpu::CompareFunction::Less),
        other => Err(format!("unsupported depth compare {other}")),
    }
}

pub(super) fn primitive_state(
    raster: &ShaderAbiRasterMode,
) -> Result<wgpu::PrimitiveState, String> {
    Ok(wgpu::PrimitiveState {
        topology: wgpu::PrimitiveTopology::TriangleList,
        front_face: match raster.front_face.as_str() {
            "ccw" => wgpu::FrontFace::Ccw,
            "cw" => wgpu::FrontFace::Cw,
            other => return Err(format!("unsupported front face {other}")),
        },
        cull_mode: match raster.cull_mode.as_str() {
            "back" => Some(wgpu::Face::Back),
            "none" => None,
            other => return Err(format!("unsupported cull mode {other}")),
        },
        ..Default::default()
    })
}

#[cfg(test)]
#[path = "gpu_descriptor_tests.rs"]
mod tests;
