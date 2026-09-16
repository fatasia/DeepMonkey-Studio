//! Platform text: editing/layout helpers, IME state, glyph-atlas bookkeeping,
//! and real font shaping/rasterization through cosmic-text in `raster`.

pub mod glyph_atlas;
pub mod font_capability;
mod image_layer;
pub mod ime;
pub mod ime_winit;
pub mod layout;
pub mod raster;
pub use raster::{RasterizedText, TextRasterRequest, TextRasterizer};
pub mod text_document;
pub mod ime_session;
pub mod text_edit;

pub use glyph_atlas::{
    AtlasSpec, AtlasUpdateError, GlyphAtlasBook, GlyphCell, MAX_CELLS, shape_run,
};
pub use font_capability::{
    FONT_CAPABILITY_SCHEMA_VERSION, FontCapabilityReport, FontFaceCapability, FontFaceIdentity,
    FontSourceKind, LicenseStatus, capability_report, family_exists, text_shapes_without_missing_glyphs,
};
pub use ime::{CompositionError, CompositionState};
pub use ime_winit::{ImeOutcome, WinitImeAdapter};
pub use layout::{Cluster, TextLine, layout_lines};
pub use ime_session::{ImeSession, ImeSessionError};
pub use text_document::{
    InlineObject, Paragraph, ParagraphAlign, StyleSpan, TextChange, TextDocumentError,
    TextDocumentV1, TextStyleId, TEXT_DOCUMENT_SCHEMA_VERSION,
};
pub use text_edit::{EditError, Move, TextEditState};
