use serde_json::Value;

use crate::shader_package::hash::sha256;

/// 自有 v1 canonical，非 JCS；JSON 标点、数组顺序、字符串转义保持不变。
/// 键按 Unicode 标量序；数字为 n + binary64 大端小写十六进制，-0 等同 0。
/// 域前缀避免与 Shader Package 等其他 SHA256 合同混用。
pub const CANONICAL_DOMAIN: &str = "deep-engine.runtime-package.canonical.v1\n";

pub(super) fn hash_canonical(value: &Value) -> String {
    let mut output = String::from(CANONICAL_DOMAIN);
    canonical(value, &mut output);
    sha256(output.as_bytes())
}

fn canonical(value: &Value, output: &mut String) {
    use std::fmt::Write;
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => {
            // serde_json 有限 JSON 数字经正确舍入后进入与 JS 相同的 binary64 域。
            let number = value.as_f64().expect("finite JSON number");
            let bits = if number == 0.0 { 0 } else { number.to_bits() };
            write!(output, "n{bits:016x}").expect("write to String");
        }
        Value::String(value) => {
            output.push_str(&serde_json::to_string(value).expect("string serialization"));
        }
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                canonical(value, output);
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut keys: Vec<_> = values.keys().collect();
            keys.sort();
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).expect("key serialization"));
                output.push(':');
                canonical(&values[*key], output);
            }
            output.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::hash_canonical;
    use serde_json::Value;

    #[test]
    fn equivalent_json_number_spellings_have_the_same_digest() {
        let hash = |input: &str| hash_canonical(&serde_json::from_str::<Value>(input).unwrap());
        for (left, right) in [
            ("1", "1.0"),
            ("-0.0", "0"),
            ("0.0000001", "1e-7"),
            ("1e21", "1e+21"),
        ] {
            assert_eq!(hash(left), hash(right));
        }
        assert_ne!(hash("1"), hash("\"n3ff0000000000000\""));
    }
}
