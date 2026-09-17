//! P3-03:签名扩展注册与 HostCapabilities 消费。
//!
//! ## 这个模块解决什么
//!
//! P1-21 的 [`crate::behavior_ir::CommandBus`] 解决了命令的**合同**(身份/幂等/
//! CAS/取消/能力/预算),但「谁有资格向总线提交命令」仍是开放问题。本模块补上
//! **扩展生命周期**:一个带签名的外部扩展经「签名验证 → ABI 协商 → 能力门控 →
//! 预算预留 → 入认证台账」注册后,方可经门控提交命令;撤销后其全部命令被拒。
//!
//! ## 签名语义(诚实边界)
//!
//! 「签名」是 **HMAC-SHA256 对称发布方认证**(`signing` 模块):宿主与发布方
//! 共享密钥、同一信任域,证明的是「描述符出自持钥发布方且未被篡改」。
//! 它**不是**公钥签名——没有身份唯一性、没有不可否认性。ed25519 与跨信任域
//! 分发是后续切片;扩展独立分发的打包格式同样不在本切片。
//!
//! ## 不建第二套状态机
//!
//! 在途/幂等/CAS/终态仍是 [`CommandBus`] 的独占状态。本模块只新增「扩展身份」
//! 一轴(在册/撤销/授权集/预算份额),命令经 `ExtensionHost::submit` 门控后
//! 原样移交总线,总线拒绝原样透传。扩展通道与纯 Native runtime 载荷
//! ([`crate::runtime_package`])严格分离:本模块不接触运行时包字节。
//!
//! ## 注册是原子判定
//!
//! 五步顺序执行,任何失败都在写入台账**之前**返回——失败路径天然无半状态,
//! 不需要回滚代码。所有拒绝都携带结构化 [`CompatibilityReport`]。

mod contract;
mod gate;
mod registry;
mod signing;

pub use contract::{
    BudgetDelta, CompatibilityReport, ExtensionCounters, ExtensionDescriptor, ExtensionHostPolicy,
    ExtensionSubmitRejection, HOST_EXTENSION_ABI_VERSION, RegistrationRejection, RevokeOutcome,
    valid_extension_id,
};
pub use registry::{ExtensionHost, ExtensionRecord};
/// 发布方入口:以共享密钥对描述符签名(发布方与宿主测试共用同一编码)。
pub use signing::sign_descriptor;

#[cfg(test)]
#[path = "behavior_extension_signing_tests.rs"]
mod signing_tests;

#[cfg(test)]
#[path = "behavior_extension_tests.rs"]
mod tests;
