//! 扩展签名原语:HMAC-SHA256(RFC 2104)发布方认证。
//!
//! ## 签名语义声明(不可误读)
//!
//! 这里的「签名」是**对称密钥发布方认证**:宿主与发布方共享同一密钥,同一信任域。
//! 它回答的问题是「这个描述符出自持有宿主密钥的发布方,且注册内容未被篡改」;
//! 它**不**回答「发布方是谁」——对称方案无法区分两个持钥方,也不提供不可否认性。
//! 公钥签名(ed25519)与跨信任域分发是后续切片;在那之前,宿主密钥泄露等价于
//! 全部扩展信任失守,密钥管理归宿主职责,本模块不做保管。
//!
//! ## 为什么是自带 SHA-256 而不是新依赖
//!
//! 复用 [`crate::shader_package::hash::Sha256`](crate 内已锁定、有 RFC 标准向量
//! 测试的纯 Rust 实现)。lock 中不存在 sha2/hmac/ed25519 crate,引入新包会改变
//! Cargo.lock 与供应链面;HMAC 构造本身只有 ipad/opad 两轮压缩,在此原语上
//! 是薄层,正确性由 RFC 4231 官方向量锚定(见 `signing_tests`)。

use crate::shader_package::hash::{Sha256, sha256_bytes};

/// SHA-256 分组长度(RFC 2104 的 B)。密钥超过 B 时先哈希再作为密钥。
const BLOCK_SIZE: usize = 64;

/// HMAC-SHA256。`key` 允许任意长度:>64 字节先压缩为 32 字节(RFC 2104 §2)。
pub(crate) fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut padded = [0_u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        padded[..32].copy_from_slice(&sha256_bytes(key));
    } else {
        padded[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(padded.map(|byte| byte ^ 0x36).as_slice());
    inner.update(message);
    let inner_digest = inner.finish_bytes();
    let mut outer = Sha256::new();
    outer.update(padded.map(|byte| byte ^ 0x5c).as_slice());
    outer.update(inner_digest.as_slice());
    outer.finish_bytes()
}

/// 描述符的签名覆盖字节:id、版本、ABI、能力集、预算逐维按固定顺序定长编码。
/// 固定编码(而非 JSON)使覆盖面无歧义:字段缺席与空集产生不同字节,
/// 攻击者无法通过重排或增删可空字段移动签名边界。
pub(super) fn signature_payload(descriptor: &super::contract::ExtensionDescriptor) -> Vec<u8> {
    use super::contract::ExtensionDescriptor;
    let ExtensionDescriptor {
        id,
        version,
        abi_version,
        required_capabilities,
        budget,
        signature: _,
    } = descriptor;
    let mut payload = Vec::new();
    payload.extend_from_slice(&(id.len() as u64).to_be_bytes());
    payload.extend_from_slice(id.as_bytes());
    payload.extend_from_slice(&version.to_be_bytes());
    payload.extend_from_slice(&abi_version.to_be_bytes());
    payload.extend_from_slice(&(required_capabilities.len() as u32).to_be_bytes());
    for capability in required_capabilities.iter() {
        payload.extend_from_slice(&capability.0.to_be_bytes());
    }
    payload.extend_from_slice(&budget.max_in_flight.to_be_bytes());
    payload.extend_from_slice(&budget.max_command_timeout_ms.to_be_bytes());
    payload.extend_from_slice(&budget.max_idempotency_keys.to_be_bytes());
    payload.extend_from_slice(&budget.min_idempotency_key_len.to_be_bytes());
    payload.extend_from_slice(&budget.max_cancelled_memory.to_be_bytes());
    payload
}

/// 以宿主密钥对描述符签名,返回 hex(64 字符)。发布方与测试共用同一入口,
/// 保证测试签的不是另一套编码。
pub fn sign_descriptor(descriptor: &mut super::contract::ExtensionDescriptor, key: &[u8]) {
    let message = signature_payload(descriptor);
    descriptor.signature = hmac_sha256(key, &message)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
}
