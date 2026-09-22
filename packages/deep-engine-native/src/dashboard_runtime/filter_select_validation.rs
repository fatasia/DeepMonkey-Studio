//! select-v1 字形池与可见行合同验证；旧展开列表不使用此合同。
use super::*;
use crate::runtime_package::DashboardNode;

impl DashboardRuntime {
    pub(super) fn validate_select_package(
        &self,
        node: &DashboardNode,
        count: usize,
    ) -> Result<(), String> {
        let Some(Deep2dRuntimeContent::Package(package)) = node
            .deep2d
            .as_ref()
            .and_then(|id| self.loaded.deep2d.get(id))
        else {
            return Err("select-v1 requires frozen option glyph packages".into());
        };
        for index in 0..count {
            let quads: Vec<_> = package
                .quads
                .iter()
                .filter(|quad| quad.z_order == index as i32 + 1)
                .collect();
            if quads.is_empty()
                || quads.iter().any(|quad| {
                    quad.destination[0] < 17.0
                        || quad.destination[1] < 17.0
                        || quad.destination[0] + quad.destination[2] > node.frame[2] - 17.0
                        || quad.destination[1] + quad.destination[3] > 49.0
                })
            {
                return Err(format!(
                    "select-v1 option {index} missing or outside its visible row"
                ));
            }
        }
        Ok(())
    }
}
