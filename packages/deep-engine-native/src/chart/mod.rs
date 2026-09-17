//! Native chart contract modules: ChartIR reader/validator (C01) lives
//! here; scales/layout/render stages grow in sibling modules.

pub mod chart_ir;
mod rows;
mod types;
pub use rows::ChartRows;
mod reader;
mod semantic_validation;
mod series_wire;
pub use reader::parse_chart_ir;
pub mod data_window;
mod emphasis;
mod initial_state;
pub mod interaction;
pub mod interaction_contract;
pub use emphasis::EmphasisState;
mod data_message;
mod epoch;
mod geometry_frame;
mod geometry_series;
pub mod layout;
mod line_point_index;
mod runtime;
pub use epoch::{ChartEpoch, ChartEpochCommit};
pub mod chunked_rows;
pub mod data_source;
pub mod simulation;
mod value_equal;
pub use data_message::{CHART_DATA_MESSAGE_MAX_BYTES, ChartDataMessage, parse_chart_data_update};
pub mod axis_render;
pub mod axis_ticks;
pub mod legend;
pub mod legend_render;
mod point_marker_render;
pub mod presentation;
mod runtime_pointer;
pub mod state_render;
pub mod tooltip_content;
pub mod tooltip_render;
pub use geometry_frame::{ChartGeometryFrame, ChartGeometryWork, ChartHitTarget};
pub use runtime::{ChartDataUpdate, ChartDataUpdateEvidence, ChartRuntime, DatasetRowsUpdate};
pub mod linking;
pub mod render;
pub use render::{render_chart, render_chart_with_hidden_series, render_chart_with_windows};
pub mod scales;

pub use chart_ir::{
    CHART_BUDGETS, CHART_IR_SCHEMA_VERSION, CHART_SPEC_SCHEMA_VERSION, ChartAxis, ChartAxisChannel,
    ChartBudgets, ChartDataset, ChartDiagnostic, ChartDiagnosticCode, ChartIR, ChartScale,
    ChartSeries, ChartSeriesType, ChartValidation, ChartValue, validate_chart_ir,
};
pub use data_window::{
    CHUNK_SIZE, ChannelAccounting, ChannelError, ChunkedSeries, Decimation, MAX_RESIDENT_POINTS,
};
pub use interaction::{ActionError, ChartAction, InteractionState, TooltipState};
pub use linking::{SelectionLink, chart_summary, trend_phrase};
