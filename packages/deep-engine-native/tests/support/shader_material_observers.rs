use super::{PlayerContent, render_observed};

pub struct Snapshot {
    pub hdr: Vec<u8>,
    pub depths: Vec<f32>,
    pub commands: Vec<Vec<[u32; 5]>>,
    pub shadow_size: u32,
    pub nonzero_vertex_offsets: usize,
}

#[derive(Debug, Default, Clone)]
pub struct ShaderMaterialReport {
    pub isolated: Vec<String>,
    pub fallback_materials: usize,
    pub custom_materials: usize,
}

pub async fn render_reported(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    content: &PlayerContent,
    reuse_first_cascade: bool,
    foreign_device: Option<&wgpu::Device>,
) -> (Snapshot, ShaderMaterialReport) {
    render_observed(
        device,
        queue,
        content,
        reuse_first_cascade,
        foreign_device,
        None,
    )
    .await
}

/// Observes real readback before GpuScene/shadows/targets/pipelines/culling/LOD leave scope.
pub async fn render_with_live_components(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    content: &PlayerContent,
    observer: &mut dyn FnMut(&Snapshot),
) -> Snapshot {
    render_observed(device, queue, content, false, None, Some(observer))
        .await
        .0
}
