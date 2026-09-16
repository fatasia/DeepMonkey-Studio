//! 从已编译配置初始化独立交互状态；失败不发布部分状态。
use super::interaction_contract::ChartInitialAction;
use super::{
    ChartAction, ChartDiagnostic, ChartDiagnosticCode, ChartIR, ChartValidation, InteractionState,
    validate_chart_ir,
};

impl InteractionState {
    pub fn from_ir(ir: &ChartIR) -> Result<Self, ChartValidation> {
        let validation = validate_chart_ir(ir);
        if !validation.valid {
            return Err(validation);
        }
        let mut state = Self::default();
        for (index, zoom) in ir.data_zoom.iter().enumerate() {
            state
                .apply(
                    ir,
                    ChartAction::Zoom {
                        axis_id: zoom.axis_id.clone(),
                        start: zoom.start / 100.0,
                        end: zoom.end / 100.0,
                    },
                )
                .map_err(|error| initialization_error(format!("$.dataZoom[{index}]"), error))?;
        }
        for (index, action) in ir.actions.iter().enumerate() {
            // 初始动作全部经 `ChartAction` 派发,与运行期同一条路径——包括
            // highlight/downplay。此前它们直接写 emphasis 状态并 continue,
            // 造成「初始能表达、运行期无入口」的双轨语义。
            let command = match action {
                ChartInitialAction::Highlight {
                    series_id,
                    data_index,
                } => ChartAction::Highlight {
                    series_id: series_id.clone(),
                    data_index: data_index.map(|value| value as usize),
                },
                ChartInitialAction::Downplay {
                    series_id,
                    data_index,
                } => ChartAction::Downplay {
                    series_id: series_id.clone(),
                    data_index: data_index.map(|value| value as usize),
                },
                ChartInitialAction::Select {
                    series_id,
                    data_index,
                } => ChartAction::Select {
                    series_id: series_id.clone(),
                    data_index: data_index.map(|value| value as usize),
                },
                ChartInitialAction::Unselect {
                    series_id,
                    data_index,
                } => ChartAction::Deselect {
                    series_id: series_id.clone(),
                    data_index: data_index.map(|value| value as usize),
                },
                ChartInitialAction::DataZoom {
                    axis_id,
                    start,
                    end,
                } => ChartAction::Zoom {
                    axis_id: axis_id.clone(),
                    start: *start / 100.0,
                    end: *end / 100.0,
                },
            };
            state
                .apply(ir, command)
                .map_err(|error| initialization_error(format!("$.actions[{index}]"), error))?;
        }
        Ok(state)
    }

    pub fn reset_from_ir(&mut self, ir: &ChartIR) -> Result<(), ChartValidation> {
        let candidate = Self::from_ir(ir)?;
        *self = candidate;
        Ok(())
    }
}

fn initialization_error(path: String, error: super::ActionError) -> ChartValidation {
    ChartValidation {
        valid: false,
        diagnostics: vec![ChartDiagnostic {
            code: ChartDiagnosticCode::InvalidValue,
            path,
            message: format!("Chart initialization failed: {error:?}"),
        }],
    }
}
