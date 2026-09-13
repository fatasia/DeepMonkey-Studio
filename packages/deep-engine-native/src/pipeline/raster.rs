#[derive(Clone, Copy)]
pub(super) struct RasterState {
    pub(super) front_face: wgpu::FrontFace,
    pub(super) cull_mode: Option<wgpu::Face>,
    pub(super) label: &'static str,
}

impl RasterState {
    pub(super) const REGULAR: Self = Self {
        front_face: wgpu::FrontFace::Ccw,
        cull_mode: Some(wgpu::Face::Back),
        label: "regular",
    };
    pub(super) const MIRRORED: Self = Self {
        front_face: wgpu::FrontFace::Cw,
        cull_mode: Some(wgpu::Face::Back),
        label: "mirrored",
    };
    pub(super) const DOUBLE_SIDED: Self = Self {
        front_face: wgpu::FrontFace::Ccw,
        cull_mode: None,
        label: "double-sided",
    };
}
