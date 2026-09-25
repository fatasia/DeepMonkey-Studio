use deep_engine_native::mesh_abi::{
    FORWARD_COLOR_FORMAT, FORWARD_DEPTH_FORMAT, FORWARD_SAMPLE_COUNT,
};
use winit::dpi::PhysicalSize;

pub const OUTLINE_MASK_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::R8Unorm;
pub const OUTLINE_DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;

// outline/forward 测试装配合同:部分窄特性目标只消费其中一组视图字段,
// 其余字段与方法作为 target 结构完整性驻留,故条目级放行 dead_code。
#[allow(dead_code)]
pub struct OutlineTargets {
    _mask: wgpu::Texture,
    _depth: wgpu::Texture,
    pub mask_view: wgpu::TextureView,
    pub depth_view: wgpu::TextureView,
}

#[allow(dead_code)]
pub struct ForwardTargets {
    pub background: Option<[f64; 3]>,
    hdr: wgpu::Texture,
    _msaa: wgpu::Texture,
    _depth: wgpu::Texture,
    pub hdr_view: wgpu::TextureView,
    pub msaa_view: wgpu::TextureView,
    pub depth_view: wgpu::TextureView,
    pub outline: Option<OutlineTargets>,
}

// 窄特性目标只驱动 new()/targets(),其余访问器为完整装配合同驻留。
#[allow(dead_code)]
impl ForwardTargets {
    pub fn new(device: &wgpu::Device, size: PhysicalSize<u32>, outline: bool) -> Self {
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
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let hdr_view = hdr.create_view(&Default::default());
        let msaa_view = msaa.create_view(&Default::default());
        let depth_view = depth.create_view(&Default::default());
        Self {
            background: None,
            hdr,
            _msaa: msaa,
            _depth: depth,
            hdr_view,
            msaa_view,
            depth_view,
            outline: outline.then(|| OutlineTargets::new(device, extent)),
        }
    }

    pub fn set_outline_enabled(&mut self, device: &wgpu::Device, enabled: bool) {
        if enabled == self.outline.is_some() {
            return;
        }
        self.outline = enabled.then(|| OutlineTargets::new(device, self.hdr.size()));
    }

    pub fn resolved_texture(&self) -> &wgpu::Texture {
        &self.hdr
    }

    /// 前向目标实际宽度(HiZ 金字塔取数基准;compact 档可为 1)。
    pub fn width(&self) -> u32 {
        self.hdr.width()
    }

    /// 前向目标实际高度。
    pub fn height(&self) -> u32 {
        self.hdr.height()
    }

    pub fn clear_color(&self) -> wgpu::Color {
        let [r, g, b] = self.background.unwrap_or([0.012, 0.020, 0.035]);
        wgpu::Color { r, g, b, a: 1.0 }
    }
}

impl OutlineTargets {
    fn new(device: &wgpu::Device, size: wgpu::Extent3d) -> Self {
        let mask = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Deep Engine native selected-object outline mask"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: OUTLINE_MASK_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let depth = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Deep Engine native selected-object depth"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: OUTLINE_DEPTH_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let mask_view = mask.create_view(&Default::default());
        let depth_view = depth.create_view(&Default::default());
        Self {
            _mask: mask,
            _depth: depth,
            mask_view,
            depth_view,
        }
    }
}
