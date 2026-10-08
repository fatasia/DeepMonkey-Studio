use std::future::Future;

use serde_json::Value;

use super::hash::CANONICAL_DOMAIN;
use crate::shader_package::hash::Sha256;

const CHUNK_BYTES: usize = 32 * 1024;

enum Part<'a> {
    Value(&'a Value),
    Array(std::slice::Iter<'a, Value>, bool),
    Object(Vec<&'a String>, usize, &'a serde_json::Map<String, Value>),
    String(&'a str, usize),
    Byte(u8),
}

/// The same canonical byte domain, bounded working memory and browser-sized tasks.
/// Splitting strings on UTF-8 boundaries preserves escaping and Unicode ordering.
pub(super) async fn hash<F, Fut>(
    value: &Value,
    yield_task: &mut F,
) -> Result<String, super::RuntimePackageError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let mut digest = Sha256::new();
    digest.update(CANONICAL_DOMAIN.as_bytes());
    let mut stack = vec![Part::Value(value)];
    let mut buffer = Vec::with_capacity(CHUNK_BYTES * 2);
    let mut task_started = web_time::Instant::now();
    while let Some(part) = stack.pop() {
        match part {
            Part::Byte(byte) => buffer.push(byte),
            Part::Value(value) => match value {
                Value::Null => buffer.extend_from_slice(b"null"),
                Value::Bool(value) => {
                    buffer.extend_from_slice(if *value { b"true" } else { b"false" })
                }
                Value::Number(value) => {
                    let number = value.as_f64().expect("finite JSON number");
                    let bits = if number == 0.0 { 0 } else { number.to_bits() };
                    buffer.extend_from_slice(format!("n{bits:016x}").as_bytes());
                }
                Value::String(text) => {
                    buffer.push(b'"');
                    stack.push(Part::String(text, 0));
                }
                Value::Array(values) => {
                    buffer.push(b'[');
                    stack.push(Part::Array(values.iter(), true));
                }
                Value::Object(values) => {
                    buffer.push(b'{');
                    let mut keys: Vec<_> = values.keys().collect();
                    keys.sort();
                    stack.push(Part::Object(keys, 0, values));
                }
            },
            Part::String(text, offset) => {
                if offset == text.len() {
                    buffer.push(b'"');
                } else {
                    let mut end = (offset + CHUNK_BYTES).min(text.len());
                    while !text.is_char_boundary(end) {
                        end -= 1;
                    }
                    let encoded =
                        serde_json::to_string(&text[offset..end]).expect("string serialization");
                    buffer.extend_from_slice(&encoded.as_bytes()[1..encoded.len() - 1]);
                    stack.push(Part::String(text, end));
                }
            }
            Part::Array(mut values, first) => match values.next() {
                None => buffer.push(b']'),
                Some(value) => {
                    if !first {
                        buffer.push(b',');
                    }
                    stack.push(Part::Array(values, false));
                    stack.push(Part::Value(value));
                }
            },
            Part::Object(keys, index, values) => {
                if index == keys.len() {
                    buffer.push(b'}');
                } else {
                    if index > 0 {
                        buffer.push(b',');
                    }
                    let key = keys[index];
                    stack.push(Part::Object(keys, index + 1, values));
                    stack.push(Part::Value(&values[key]));
                    stack.push(Part::Byte(b':'));
                    buffer.push(b'"');
                    stack.push(Part::String(key, 0));
                }
            }
        }
        if buffer.len() >= CHUNK_BYTES {
            digest.update(&buffer);
            buffer.clear();
            if task_started.elapsed().as_millis() >= 8 {
                if yield_task().await {
                    return super::fail("scene package preparation cancelled");
                }
                task_started = web_time::Instant::now();
            }
        }
    }
    digest.update(&buffer);
    Ok(digest.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chunk_boundaries_preserve_the_canonical_domain() {
        for value in [
            json!({"z": [1, -0.0, true, null], "键": "😀\n\"\\".repeat(40_000)}),
            json!(["a".repeat(CHUNK_BYTES - 1), "😀".repeat(CHUNK_BYTES), ""]),
        ] {
            let mut yields = 0;
            let actual = pollster::block_on(hash(&value, &mut || {
                yields += 1;
                std::future::ready(false)
            }))
            .unwrap();
            assert_eq!(actual, super::super::hash::hash_canonical(&value));
            // A fast native hash may finish inside one browser task budget.
            let _ = yields;
        }
    }
}
