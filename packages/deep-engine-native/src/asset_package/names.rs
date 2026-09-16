pub(super) fn token(value: &str, max: usize, punctuation: &str, lowercase: bool) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || punctuation.as_bytes().contains(&c))
        && (!lowercase || !value.bytes().any(|c| c.is_ascii_uppercase()))
}
pub(super) fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub(super) fn id(value: &str) -> bool {
    token(value, 256, "._:/-", true)
        && (value.as_bytes()[0].is_ascii_digit()
            || value.as_bytes().get(1).is_none_or(|c| *c != b':'))
        && value.split('/').all(|part| {
            !matches!(
                part,
                "" | "." | ".." | "__proto__" | "prototype" | "constructor"
            )
        })
}
pub(super) fn logical(value: &str) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= 512
        && !value.starts_with('/')
        && !value
            .chars()
            .any(|c| c <= '\u{1f}' || "\\:*?\"<>|".contains(c))
        && nfc(value)
        && value.split('/').all(|part| {
            let lower = part.to_lowercase();
            let base = lower.split('.').next().unwrap_or("");
            !matches!(
                lower.as_str(),
                "" | "." | ".." | "__proto__" | "prototype" | "constructor"
            ) && !part.ends_with(['.', ' '])
                && !matches!(base, "con" | "prn" | "aux" | "nul")
                && !(base.len() == 4
                    && (base.starts_with("com") || base.starts_with("lpt"))
                    && matches!(base.as_bytes()[3], b'1'..=b'9'))
        })
}
#[cfg(windows)]
fn nfc(value: &str) -> bool {
    #[link(name = "Normaliz")]
    unsafe extern "system" {
        fn IsNormalizedString(form: i32, text: *const u16, length: i32) -> i32;
    }
    let text: Vec<u16> = value.encode_utf16().collect();
    // The bounded UTF-16 slice remains alive throughout the synchronous OS query.
    unsafe { IsNormalizedString(1, text.as_ptr(), text.len() as i32) != 0 }
}
#[cfg(not(windows))]
fn nfc(value: &str) -> bool {
    value.is_ascii()
}
