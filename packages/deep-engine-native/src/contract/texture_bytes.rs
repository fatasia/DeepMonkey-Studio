use serde::{
    Deserializer,
    de::{self, SeqAccess, Visitor},
};

const MAX_BYTES: usize = 128 * 1024 * 1024;

/// Numeric arrays retain the original wire contract; strings use canonical RFC 4648.
pub(super) fn deserialize<'de, D: Deserializer<'de>>(input: D) -> Result<Vec<u8>, D::Error> {
    struct Bytes;
    impl<'de> Visitor<'de> for Bytes {
        type Value = Vec<u8>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("texture byte array or canonical RFC 4648 base64")
        }
        fn visit_str<E: de::Error>(self, text: &str) -> Result<Self::Value, E> {
            if text.len() > MAX_BYTES.div_ceil(3) * 4 {
                return Err(E::custom("texture data exceeds the 128 MiB packet budget"));
            }
            let length = crate::deep2d::runtime_base64::decoded_len(text).map_err(E::custom)?;
            if length > MAX_BYTES {
                return Err(E::custom("texture data exceeds the 128 MiB packet budget"));
            }
            crate::deep2d::runtime_base64::decode(text).map_err(E::custom)
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut source: A) -> Result<Self::Value, A::Error> {
            if source.size_hint().is_some_and(|length| length > MAX_BYTES) {
                return Err(de::Error::custom(
                    "texture data exceeds the 128 MiB packet budget",
                ));
            }
            let mut bytes = Vec::with_capacity(source.size_hint().unwrap_or(0));
            while let Some(byte) = source.next_element::<u8>()? {
                if bytes.len() == MAX_BYTES {
                    return Err(de::Error::custom(
                        "texture data exceeds the 128 MiB packet budget",
                    ));
                }
                bytes.push(byte);
            }
            Ok(bytes)
        }
    }
    input.deserialize_any(Bytes)
}

#[cfg(test)]
mod tests {
    use super::super::{PixelLevel, TextureResource};

    #[test]
    fn canonical_base64_and_legacy_arrays_restore_identical_bytes() {
        let base = r#"{"id":"color","revision":1,"semantic":"specularColor","width":1,"height":1,"data":"gED//w=="}"#;
        let compact: TextureResource = serde_json::from_str(base).unwrap();
        let legacy: TextureResource =
            serde_json::from_str(&base.replace("\"gED//w==\"", "[128,64,255,255]")).unwrap();
        assert_eq!(compact.data, legacy.data);
        let mip: PixelLevel =
            serde_json::from_str(r#"{"width":1,"height":1,"data":"gED//w=="}"#).unwrap();
        assert_eq!(mip.data, compact.data);
    }

    #[test]
    fn malformed_base64_and_non_byte_numeric_payloads_are_rejected() {
        for data in [
            r#""AB==""#,
            r#""AQJ=""#,
            r#""AQI= ""#,
            r#""AA=A""#,
            r#""""#,
            "[256]",
            "[-1]",
            "[0.5]",
            "null",
        ] {
            let json = format!(r#"{{"width":1,"height":1,"data":{data}}}"#);
            assert!(serde_json::from_str::<PixelLevel>(&json).is_err(), "{data}");
        }
    }
}
