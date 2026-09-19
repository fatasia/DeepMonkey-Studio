//! Opt-in counters: no clock reads when profiling is disabled.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct TextRasterProfile {
    pub measure_calls: u64,
    pub measure_nanos: u128,
    pub raster_calls: u64,
    pub raster_nanos: u128,
    pub glyph_probe_calls: u64,
    pub glyph_probe_nanos: u128,
}

impl super::TextRasterizer {
    pub fn start_profile(&mut self) {
        self.profile = Some(TextRasterProfile::default());
    }

    pub fn profile(&self) -> Option<&TextRasterProfile> {
        self.profile.as_ref()
    }
}
