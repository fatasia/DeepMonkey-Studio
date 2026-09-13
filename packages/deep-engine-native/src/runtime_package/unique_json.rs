use std::fmt;

use serde::de::{DeserializeSeed, Error, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};

use super::validate::{MAX_JSON_DEPTH, MAX_JSON_NODES};

// Value 的默认解码会覆盖重复字段；同时在分配子树前执行预算检查。
pub(super) fn parse(bytes: &[u8]) -> Result<Value, serde_json::Error> {
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    let value = JsonSeed {
        depth: 0,
        nodes: &mut 0,
    }
    .deserialize(&mut decoder)?;
    decoder.end()?;
    Ok(value)
}

struct JsonSeed<'a> {
    depth: usize,
    nodes: &'a mut usize,
}

impl<'de> DeserializeSeed<'de> for JsonSeed<'_> {
    type Value = Value;

    fn deserialize<D>(self, decoder: D) -> Result<Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        *self.nodes += 1;
        if *self.nodes > MAX_JSON_NODES || self.depth > MAX_JSON_DEPTH {
            return Err(D::Error::custom(
                "Deep Runtime Package exceeds its JSON node or depth budget",
            ));
        }
        decoder.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for JsonSeed<'_> {
    type Value = Value;

    fn expecting(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str("JSON with unique object fields")
    }

    fn visit_unit<E: Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_bool<E: Error>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E: Error>(self, value: i64) -> Result<Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_u64<E: Error>(self, value: u64) -> Result<Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_f64<E: Error>(self, value: f64) -> Result<Value, E> {
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom("non-finite JSON number"))
    }

    fn visit_str<E: Error>(self, value: &str) -> Result<Value, E> {
        Ok(Value::String(value.into()))
    }

    fn visit_string<E: Error>(self, value: String) -> Result<Value, E> {
        Ok(Value::String(value))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut source: A) -> Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = source.next_element_seed(JsonSeed {
            depth: self.depth + 1,
            nodes: self.nodes,
        })? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut source: A) -> Result<Value, A::Error> {
        let mut values = Map::new();
        while let Some(key) = source.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(A::Error::custom(format!("duplicate JSON field: {key}")));
            }
            let value = source.next_value_seed(JsonSeed {
                depth: self.depth + 1,
                nodes: self.nodes,
            })?;
            values.insert(key, value);
        }
        Ok(Value::Object(values))
    }
}
