//! 回放宿主模型:命令载荷的唯一应用处与种子化随机源。
//!
//! 与真实宿主的分工相同——总线管合同,这里管语义;区别是本模型**零 IO、
//! 零时钟、零线程**:`RequestData`/`CancelTask` 只推进记账计数,绝不触发
//! 任何数据获取,网络副作用只允许出现在测试显式构造的 replay fixture 里。
//! 状态全部是封闭字段,便于整步摘要与双跑逐字节比较。

use crate::behavior_ir::{BehaviorPayload, BehaviorProperty, BehaviorTarget, Scalar};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

/// 场景中一个节点的全部可命令状态。缺省即「可见、不透明、无变换」。
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct SceneCell {
    pub visible: bool,
    pub opacity: f64,
    pub rotation: f64,
    pub scale: f64,
    pub tint: f64,
    pub page: u32,
}

impl Default for SceneCell {
    fn default() -> Self {
        Self {
            visible: true,
            opacity: 1.0,
            rotation: 0.0,
            scale: 1.0,
            tint: 0.0,
            page: 0,
        }
    }
}

/// 数值属性的确定性换算:Number 原样、Index 视作数值;布尔对数值属性
/// 不产生任何效果(规则本身是确定性的,双跑一致)。
fn scalar_number(value: &Scalar) -> Option<f64> {
    match value {
        Scalar::Number(value) => Some(*value),
        Scalar::Index(value) => Some(f64::from(*value)),
        Scalar::Bool(_) => None,
    }
}

/// 回放目标状态。字段私有、访问只读,保证摘要与状态一一对应。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ReplayTarget {
    scene: BTreeMap<String, SceneCell>,
    selection: BTreeSet<String>,
    focused: Option<String>,
    data_requests: u64,
    cancelled_tasks: u64,
}

impl ReplayTarget {
    pub fn scene(&self) -> &BTreeMap<String, SceneCell> {
        &self.scene
    }
    pub fn selection(&self) -> &BTreeSet<String> {
        &self.selection
    }
    pub fn focused(&self) -> Option<&str> {
        self.focused.as_deref()
    }
    pub fn data_requests(&self) -> u64 {
        self.data_requests
    }
    pub fn cancelled_tasks(&self) -> u64 {
        self.cancelled_tasks
    }
}

impl BehaviorTarget for ReplayTarget {
    fn apply(&mut self, payload: &BehaviorPayload) -> Result<(), String> {
        match payload {
            BehaviorPayload::SetProperty {
                node_id,
                property,
                value,
            } => {
                let cell = self.scene.entry(node_id.clone()).or_default();
                match property {
                    BehaviorProperty::Opacity => {
                        if let Some(value) = scalar_number(value) {
                            cell.opacity = value;
                        }
                    }
                    BehaviorProperty::Rotation => {
                        if let Some(value) = scalar_number(value) {
                            cell.rotation = value;
                        }
                    }
                    BehaviorProperty::Scale => {
                        if let Some(value) = scalar_number(value) {
                            cell.scale = value;
                        }
                    }
                    BehaviorProperty::Tint => {
                        if let Some(value) = scalar_number(value) {
                            cell.tint = value;
                        }
                    }
                }
            }
            BehaviorPayload::SetVisible { node_id, visible } => {
                self.scene.entry(node_id.clone()).or_default().visible = *visible;
            }
            // 非追加选择先清空再选:`additive=false` 表达「就选这一个」。
            BehaviorPayload::Select {
                node_id,
                additive: false,
            } => {
                self.selection.clear();
                self.selection.insert(node_id.clone());
            }
            BehaviorPayload::Select {
                node_id,
                additive: true,
            } => {
                self.selection.insert(node_id.clone());
            }
            BehaviorPayload::ClearSelection => self.selection.clear(),
            BehaviorPayload::SetPage { node_id, page } => {
                self.scene.entry(node_id.clone()).or_default().page = *page;
            }
            BehaviorPayload::Focus { node_id } => self.focused = Some(node_id.clone()),
            BehaviorPayload::RequestData { .. } => self.data_requests += 1,
            BehaviorPayload::CancelTask { .. } => self.cancelled_tasks += 1,
        }
        Ok(())
    }
}

/// splitmix64:纯函数、无真实熵源。任意种子(含 0)都能推进,
/// 同一种子永远得到同一序列——回放「随机」因此可逐字节复现。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayRng {
    state: u64,
}

impl ReplayRng {
    pub fn new(seed: u64) -> Self {
        Self { state: seed }
    }
    pub fn state(&self) -> u64 {
        self.state
    }
    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// [0, 1) 的均匀 f64:取 53 位尾数,不产生 NaN/无穷。
    pub fn next_unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}
