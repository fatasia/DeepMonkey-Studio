use super::{BehaviorPayload, Scalar, stable_node_id};

/// 载荷自身的合法性:数值有限、页码在界、id 形状正确。
pub(super) fn validate_payload(payload: &BehaviorPayload) -> Result<(), &'static str> {
    match payload {
        BehaviorPayload::SetProperty {
            node_id,
            value,
            property: _,
        } => {
            require_node(node_id)?;
            match value {
                Scalar::Number(number) => {
                    if !number.is_finite() {
                        return Err("property number must be finite");
                    }
                    Ok(())
                }
                Scalar::Bool(_) | Scalar::Index(_) => Ok(()),
            }
        }
        BehaviorPayload::SetVisible { node_id, .. } | BehaviorPayload::Focus { node_id } => {
            require_node(node_id)
        }
        BehaviorPayload::Select { node_id, .. } => require_node(node_id),
        BehaviorPayload::ClearSelection => Ok(()),
        BehaviorPayload::SetPage { node_id, page } => {
            require_node(node_id)?;
            if *page > 65_535 {
                return Err("page index out of range");
            }
            Ok(())
        }
        BehaviorPayload::RequestData { dataset_id, .. } => require_node(dataset_id),
        BehaviorPayload::CancelTask { task_id } => require_node(task_id),
    }
}

fn require_node(value: &str) -> Result<(), &'static str> {
    if stable_node_id(value) {
        Ok(())
    } else {
        Err("identity is not a stable id")
    }
}
