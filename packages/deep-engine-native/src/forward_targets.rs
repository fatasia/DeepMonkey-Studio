use deep_engine_native::mesh_abi::{
    FORWARD_COLOR_FORMAT, FORWARD_DEPTH_FORMAT, FORWARD_SAMPLE_COUNT,
};
use winit::dpi::PhysicalSize;

pub struct ForwardTargets {
    hdr: wgpu::Texture,
    _msaa: wgpu::Texture,
    _depth: wgpu::Texture,
    pub hdr_view: wgpu::TextureView,
    pub msaa_view: wgpu::TextureView,
    pub depth_view: wgpu::TextureView,
}

impl ForwardTargets {
    pub fn new(device: &wgpu::Device, size: PhysicalSize<u32>) -> Self {
        let extent = wgpu::Extent3d {
            width: size.width.max(1),
            height: size.height.max(1),
            depth_or_array_layers: 1,
        };
        let hdr = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Deep Engine native resolved HDR color"),
            size: extent,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: FORWARD_COLOR_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let msaa = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Deep Engine native 4x MSAA HDR color"),
            size: extent,
            mip_level_count: 1,
            sample_count: FORWARD_SAMPLE_COUNT,
            dimension: wgpu::TextureDimension::D2,
            format: FORWARD_COLOR_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let depth = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Deep Engine native 4x forward depth"),
            size: extent,
            mip_level_count: 1,
            sample_count: FORWARD_SAMPLE_COUNT,
            dimension: wgpu::TextureDimension::D2,
            format: FORWARD_DEPTH_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let hdr_view = hdr.create_view(&Default::default());
        let msaa_view = msaa.create_view(&Default::default());
        let depth_view = depth.create_view(&Default::default());
        Self {
            hdr,
            _msaa: msaa,
            _depth: depth,
            hdr_view,
            msaa_view,
            depth_view,
        }
    }

    pub fn resolved_texture(&self) -> &wgpu::Texture {
        &self.hdr
    }
}
