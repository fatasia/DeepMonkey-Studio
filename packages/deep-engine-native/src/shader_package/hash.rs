use serde_json::Value;

pub(crate) fn hash_canonical(value: &Value) -> String {
    let mut text = String::new();
    canonical(value, &mut text);
    sha256(text.as_bytes())
}

fn canonical(value: &Value, output: &mut String) {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(item) => output.push_str(if *item { "true" } else { "false" }),
        Value::Number(item) => output.push_str(&item.to_string()),
        Value::String(item) => {
            output.push_str(&serde_json::to_string(item).expect("string serialization"));
        }
        Value::Array(items) => {
            output.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                canonical(item, output);
            }
            output.push(']');
        }
        Value::Object(items) => {
            output.push('{');
            let mut keys: Vec<_> = items.keys().collect();
            keys.sort();
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).expect("key serialization"));
                output.push(':');
                canonical(&items[*key], output);
            }
            output.push('}');
        }
    }
}

pub(crate) struct Sha256 {
    state: [u32; 8],
    block: [u8; 64],
    used: usize,
    bytes: u64,
}

impl Sha256 {
    pub(crate) fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            block: [0; 64],
            used: 0,
            bytes: 0,
        }
    }

    pub(crate) fn update(&mut self, mut input: &[u8]) {
        self.bytes = self
            .bytes
            .checked_add(input.len() as u64)
            .expect("SHA-256 input length exceeds u64 bytes");
        if self.used > 0 {
            let take = (64 - self.used).min(input.len());
            self.block[self.used..self.used + take].copy_from_slice(&input[..take]);
            self.used += take;
            input = &input[take..];
            if self.used == 64 {
                compress(&mut self.state, &self.block);
                self.used = 0;
            }
        }
        for chunk in input.chunks_exact(64) {
            compress(&mut self.state, chunk.try_into().expect("SHA-256 block"));
        }
        let remainder = input.len() % 64;
        if remainder > 0 {
            let tail = &input[input.len() - remainder..];
            self.block[..remainder].copy_from_slice(tail);
            self.used = remainder;
        }
    }

    pub(crate) fn finish(self) -> String {
        self.finish_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    /// 原始 32 字节摘要;`finish` 的 hex 串由此派生。HMAC 等需要以摘要
    /// 字节继续参与下一轮压缩的原语消费这里,不走 hex 往返。
    pub(crate) fn finish_bytes(mut self) -> [u8; 32] {
        let bit_len = self
            .bytes
            .checked_mul(8)
            .expect("SHA-256 bit length overflow");
        self.block[self.used] = 0x80;
        self.used += 1;
        if self.used > 56 {
            self.block[self.used..].fill(0);
            compress(&mut self.state, &self.block);
            self.block.fill(0);
        } else {
            self.block[self.used..56].fill(0);
        }
        self.block[56..].copy_from_slice(&bit_len.to_be_bytes());
        compress(&mut self.state, &self.block);
        let mut digest = [0_u8; 32];
        for (slot, word) in digest.chunks_exact_mut(4).zip(self.state) {
            slot.copy_from_slice(&word.to_be_bytes());
        }
        digest
    }
}

impl Default for Sha256 {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) fn sha256(input: &[u8]) -> String {
    sha256_bytes(input)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn sha256_bytes(input: &[u8]) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(input);
    hash.finish_bytes()
}

fn compress(state: &mut [u32; 8], chunk: &[u8; 64]) {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut words = [0_u32; 64];
    for (index, word) in words[..16].iter_mut().enumerate() {
        *word = u32::from_be_bytes(chunk[index * 4..index * 4 + 4].try_into().expect("word"));
    }
    for index in 16..64 {
        let a = words[index - 15];
        let b = words[index - 2];
        words[index] = words[index - 16]
            .wrapping_add(a.rotate_right(7) ^ a.rotate_right(18) ^ (a >> 3))
            .wrapping_add(words[index - 7])
            .wrapping_add(b.rotate_right(17) ^ b.rotate_right(19) ^ (b >> 10));
    }
    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
    for index in 0..64 {
        let t1 = h
            .wrapping_add(e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25))
            .wrapping_add((e & f) ^ (!e & g))
            .wrapping_add(K[index])
            .wrapping_add(words[index]);
        let t2 = (a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22))
            .wrapping_add((a & b) ^ (a & c) ^ (b & c));
        h = g;
        g = f;
        f = e;
        e = d.wrapping_add(t1);
        d = c;
        c = b;
        b = a;
        a = t1.wrapping_add(t2);
    }
    for (slot, value) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
        *slot = slot.wrapping_add(value);
    }
}

#[cfg(test)]
mod tests {
    use super::{Sha256, sha256};

    #[test]
    fn matches_standard_sha256_vectors() {
        assert_eq!(
            sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        let mut streamed = Sha256::new();
        streamed.update(b"a");
        streamed.update(b"b");
        streamed.update(b"c");
        assert_eq!(streamed.finish(), sha256(b"abc"));
        let mut million = Sha256::new();
        for _ in 0..1_000 {
            million.update(&[b'a'; 1_000]);
        }
        assert_eq!(
            million.finish(),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }
}
