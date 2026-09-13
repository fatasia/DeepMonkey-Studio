use crate::contract::AlphaMode;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShadowCasterMode {
    Solid,
    MaskPlain,
    MaskMaterial,
}

pub fn shadow_caster_mode(
    alpha_mode: AlphaMode,
    base_color_mapped: bool,
) -> Option<ShadowCasterMode> {
    match alpha_mode {
        AlphaMode::Opaque => Some(ShadowCasterMode::Solid),
        AlphaMode::Mask if base_color_mapped => Some(ShadowCasterMode::MaskMaterial),
        AlphaMode::Mask => Some(ShadowCasterMode::MaskPlain),
        AlphaMode::Blend => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShadowVersion {
    pub scene: u64,
    pub light: u64,
    pub shader: u64,
}

impl ShadowVersion {
    pub const INITIAL: Self = Self {
        scene: 1,
        light: 1,
        shader: 0,
    };

    pub fn bump_scene(&mut self) {
        self.scene = self.scene.wrapping_add(1);
    }

    pub fn bump_light(&mut self) {
        self.light = self.light.wrapping_add(1);
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ShadowCache {
    rendered: Option<ShadowVersion>,
}

impl ShadowCache {
    pub fn needs_render(&self, current: ShadowVersion) -> bool {
        self.rendered != Some(current)
    }

    pub fn commit(&mut self, rendered: ShadowVersion) {
        self.rendered = Some(rendered);
    }

    pub fn invalidate(&mut self) {
        self.rendered = None;
    }

    pub fn rendered(&self) -> Option<ShadowVersion> {
        self.rendered
    }
}
