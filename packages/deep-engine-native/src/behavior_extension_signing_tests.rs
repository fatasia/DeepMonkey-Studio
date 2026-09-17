//! HMAC-SHA256 原语测试:RFC 4231 官方向量锚定(短密钥/文本密钥/超块长密钥),
//! 外加覆盖编码 determinism 与签名-验证闭环。

use super::contract::ExtensionDescriptor;
use super::signing::{hmac_sha256, sign_descriptor, signature_payload};
use crate::behavior_ir::{CapabilityId, CommandBudget};
use std::collections::BTreeSet;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn matches_rfc4231_vectors() {
    // Test Case 1:短密钥(0x0b × 20)。
    let key = [0x0b_u8; 20];
    assert_eq!(
        hex(&hmac_sha256(&key, b"Hi There")),
        "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
    );
    // Test Case 2:文本密钥 "Jefe"。
    assert_eq!(
        hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
    );
    // Test Case 6:密钥长于块长(0xaa × 131),走「先哈希再作密钥」分支。
    let long_key = [0xaa_u8; 131];
    assert_eq!(
        hex(&hmac_sha256(
            &long_key,
            b"Test Using Larger Than Block-Size Key - Hash Key First"
        )),
        "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
    );
    // Test Case 7:超块长密钥 + 超块长数据。
    assert_eq!(
        hex(&hmac_sha256(
            &long_key,
            b"This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm."
        )),
        "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2"
    );
}

fn descriptor() -> ExtensionDescriptor {
    ExtensionDescriptor {
        id: "vendor.grid".into(),
        version: 3,
        abi_version: 1,
        required_capabilities: BTreeSet::from([CapabilityId(2), CapabilityId(9)]),
        budget: CommandBudget::default(),
        signature: String::new(),
    }
}

#[test]
fn sign_descriptor_roundtrip_changes_with_content() {
    let key = b"host-shared-secret";
    let mut signed = descriptor();
    sign_descriptor(&mut signed, key);
    assert_eq!(signed.signature.len(), 64);
    assert!(
        signed
            .signature
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    );

    // 同内容重签一致(确定性,发布方与宿主可复算同一编码)。
    let mut again = descriptor();
    sign_descriptor(&mut again, key);
    assert_eq!(signed.signature, again.signature);

    // 内容任何一处变化 → 覆盖字节变化 → 签名必然不同。
    for mutate in [
        |d: &mut ExtensionDescriptor| d.version += 1,
        |d: &mut ExtensionDescriptor| d.abi_version += 1,
        |d: &mut ExtensionDescriptor| {
            d.required_capabilities = BTreeSet::from([CapabilityId(2)]);
        },
        |d: &mut ExtensionDescriptor| {
            d.budget.max_in_flight += 1;
        },
        |d: &mut ExtensionDescriptor| d.id.push('x'),
    ] {
        let mut tampered = descriptor();
        sign_descriptor(&mut tampered, key);
        mutate(&mut tampered);
        let payload = signature_payload(&tampered);
        assert_ne!(
            hex(&hmac_sha256(key, &payload)),
            signed.signature,
            "tampering a field must change the signature"
        );
    }

    // 换密钥 → 签名不同(对称信任域边界就在密钥上)。
    let mut other_key = descriptor();
    sign_descriptor(&mut other_key, b"another-secret");
    assert_ne!(signed.signature, other_key.signature);
}
