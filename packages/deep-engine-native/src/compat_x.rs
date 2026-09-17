//! P2-01: 实验兼容目标 X 的隔离开关与受限宿主合同。
//!
//! X 与纯原生 N0 是两条不同的 lane：`NativeN0` 永远不会进入本执行器。
//! 本首切片也不加载或解释 JavaScript；[`XCall`] 是封闭适配 ABI。宿主只能注入值类型的
//! 资源字节、逻辑时钟、随机种子和事件，API 中没有 DOM、GPU、文件或网络宿主对象。
//! 预算在产生候选前硬拒绝，发布时再核对 epoch、取消与 wall-clock，失败不产出部分消息。

mod contract;
mod host;

pub use contract::*;
pub use host::XCompatibilityHost;

#[cfg(test)]
#[path = "compat_x_tests.rs"]
mod tests;
