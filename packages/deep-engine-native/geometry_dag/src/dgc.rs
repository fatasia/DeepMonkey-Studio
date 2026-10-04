//! `.dgc`(Deep Geometry Clusters)流式二进制格式:分块 + 父子索引 + 边界锁定。
//!
//! 完整字节级规格见 `docs/dgc-format-spec.md`;本模块是唯一权威读写实现。
//! 设计目标:
//! - 全小端、段 payload 8 字节对齐,可直接映射到 typed array 视图;
//! - 每段独立 CRC32C 校验,文件尺寸自锁定(total_file_size);
//! - 保留字段必须为 0(读取即校验),为后续版本演进留护栏;
//! - 段 payload 可选 zlib(RFC 1950)压缩,压缩比记录在段头。

use std::io::Write;

use flate2::write::ZlibEncoder;
use flate2::Compression;

use crate::error::{DagError, DagResult};
use crate::dag::{DagLevel, MeshletDag};
use crate::types::{MESHLET_MAX_TRIANGLES_LIMIT, MESHLET_MAX_VERTICES_LIMIT};

/// 魔数 `DGC1`。
pub const MAGIC: [u8; 4] = *b"DGC1";
/// 当前格式版本。
pub const FORMAT_VERSION: u32 = 1;
/// 文件头尺寸(字节)。
pub const FILE_HEADER_SIZE: usize = 64;
/// 段头尺寸(字节)。
pub const SECTION_HEADER_SIZE: usize = 88;
/// 段 payload 对齐(字节)。
pub const PAYLOAD_ALIGNMENT: usize = 8;

/// 段类型:level 几何块。
pub const SECTION_KIND_LEVEL: u32 = 0;
/// 段类型:parents 块(kind=1 时 `level` 字段为细层号 k,连接 k 与 k+1)。
pub const SECTION_KIND_PARENTS: u32 = 1;

/// flags bit0:段 payload 为 zlib 压缩。
pub const FLAG_ZLIB: u32 = 1 << 0;

/// 无父簇哨兵(细簇在粗层无覆盖;对应 golden fixture 的 -1)。
pub const NO_PARENT: u32 = u32::MAX;

/// 序列化选项。
#[derive(Debug, Clone, Copy)]
pub struct DgcWriteOptions {
    /// 是否 zlib 压缩段 payload(默认开:体积意识,不做硬门)。
    pub compress: bool,
}

impl Default for DgcWriteOptions {
    fn default() -> Self {
        Self { compress: true }
    }
}

/// 序列化 DAG 为 `.dgc` 字节流。
///
/// # Errors
/// 层级/簇数超出 `u32` 可表示范围时返回 [`DagError::Overflow`]。
pub fn write_dgc(dag: &MeshletDag, options: &DgcWriteOptions) -> DagResult<Vec<u8>> {
    let level_count = dag.levels.len();
    if level_count == 0 {
        return Err(DagError::dgc_format("cannot serialize an empty DAG"));
    }
    let parent_pair_count = dag.parents_by_level.len();
    if parent_pair_count != level_count.saturating_sub(1) {
        return Err(DagError::dgc_format(format!(
            "parents_by_level has {parent_pair_count} entries for {level_count} levels; expected {}",
            level_count.saturating_sub(1)
        )));
    }
    let section_count = level_count + parent_pair_count;
    let level0 = &dag.levels[0];
    let source_vertex_count = level0.positions.len() / 3;
    let source_triangle_count = level0.indices.len() / 3;
    if source_vertex_count > u32::MAX as usize || source_triangle_count > u32::MAX as usize {
        return Err(DagError::overflow("source counts exceed u32"));
    }

    // 预编码全部段 payload,以便回填绝对偏移。
    let mut sections: Vec<SectionRecord> = Vec::with_capacity(section_count);
    for level in &dag.levels {
        if level.meshlet_count > u32::MAX as usize {
            return Err(DagError::overflow("meshlet count exceeds u32"));
        }
        let mut payload = Vec::new();
        let counts = [
            level.positions.len(),
            level.indices.len(),
            level.descriptors.len(),
            level.vertex_remap.len(),
            level.local_triangle_indices.len(),
            level.bounds.len(),
            level.source_triangles.len(),
            level.cluster_source_spans.len(),
        ];
        extend_le_f32(&mut payload, &level.positions);
        extend_le_u32(&mut payload, &level.indices);
        extend_le_u32(&mut payload, &level.descriptors);
        extend_le_u32(&mut payload, &level.vertex_remap);
        extend_le_u32(&mut payload, &level.local_triangle_indices);
        extend_le_f32(&mut payload, &level.bounds);
        extend_le_u32(&mut payload, &level.source_triangles);
        extend_le_u32(&mut payload, &level.cluster_source_spans);
        sections.push(SectionRecord {
            kind: SECTION_KIND_LEVEL,
            level: level.level,
            error: level.error,
            counts,
            raw: payload,
            payload_offset: 0,
        });
    }
    for (k, parents) in dag.parents_by_level.iter().enumerate() {
        let k = k as u32;
        if k + 1 >= level_count as u32 {
            return Err(DagError::dgc_format("parents level index out of range"));
        }
        let coarse_count = dag.levels[k as usize + 1].meshlet_count;
        for &parent in parents {
            if parent != NO_PARENT && parent as usize >= coarse_count {
                return Err(DagError::dgc_format(format!(
                    "parent {parent} out of range for coarse level {} ({coarse_count} clusters)",
                    k + 1
                )));
            }
        }
        let mut payload = Vec::new();
        extend_le_u32(&mut payload, parents);
        sections.push(SectionRecord {
            kind: SECTION_KIND_PARENTS,
            level: k,
            error: 0.0,
            counts: [parents.len(), 0, 0, 0, 0, 0, 0, 0],
            raw: payload,
            payload_offset: 0,
        });
    }

    // 文件头 + 段头区,然后逐段 8 对齐 payload。
    let header_span = FILE_HEADER_SIZE + SECTION_HEADER_SIZE * section_count;
    let mut offset = header_span;
    let mut stored_payloads: Vec<Vec<u8>> = Vec::with_capacity(sections.len());
    for section in &mut sections {
        let stored = if options.compress {
            let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(6));
            encoder
                .write_all(&section.raw)
                .map_err(|e| DagError::Io { path: std::path::PathBuf::from("<memory>"), source: e })?;
            encoder.finish().map_err(|e| DagError::Io {
                path: std::path::PathBuf::from("<memory>"),
                source: std::io::Error::other(e),
            })?
        } else {
            section.raw.clone()
        };
        offset = align_up(offset, PAYLOAD_ALIGNMENT);
        section.payload_offset = offset as u64;
        offset += stored.len();
        stored_payloads.push(stored);
    }
    let total_size = offset;
    // 边界锁定护栏:单文件 64 GiB 上限(防错位字段导致的荒谬分配)。
    if total_size > 64 * 1024 * 1024 * 1024 {
        return Err(DagError::overflow("serialized DAG exceeds 64 GiB sanity bound"));
    }

    let mut out = Vec::with_capacity(total_size);
    // 文件头(64B)。
    out.extend_from_slice(&MAGIC);
    extend_le_u32(&mut out, &[FORMAT_VERSION]);
    let mut flags = 0u32;
    if options.compress {
        flags |= FLAG_ZLIB;
    }
    extend_le_u32(&mut out, &[flags]);
    extend_le_u32(&mut out, &[level_count as u32]);
    extend_le_u32(&mut out, &[parent_pair_count as u32]);
    extend_le_u32(&mut out, &[source_vertex_count as u32]);
    extend_le_u32(&mut out, &[source_triangle_count as u32]);
    extend_le_u32(&mut out, &[level0.max_vertices]);
    extend_le_u32(&mut out, &[level0.max_triangles]);
    extend_le_u64(&mut out, &[total_size as u64]);
    // reserved 20 字节(读取校验必须全 0):文件头精确 64 字节。
    out.extend_from_slice(&[0u8; 20]);
    debug_assert_eq!(out.len(), FILE_HEADER_SIZE);

    // 段头 ×N。
    for (index, (section, stored)) in sections.iter().zip(&stored_payloads).enumerate() {
        extend_le_u32(&mut out, &[section.kind]);
        extend_le_u32(&mut out, &[section.level]);
        extend_le_f64(&mut out, &[section.error]);
        extend_le_u32(&mut out, &section.counts.map(|c| u32::try_from(c).unwrap_or(u32::MAX)));
        extend_le_u64(&mut out, &[section.raw.len() as u64]);
        extend_le_u64(&mut out, &[stored.len() as u64]);
        extend_le_u64(&mut out, &[section.payload_offset]);
        extend_le_u32(&mut out, &[crc32c(&section.raw)]);
        // reserved 12 字节(读取校验必须全 0):段头精确 88 字节。
        extend_le_u32(&mut out, &[0]);
        extend_le_u32(&mut out, &[0]);
        extend_le_u32(&mut out, &[0]);
        debug_assert_eq!(out.len(), FILE_HEADER_SIZE + (index + 1) * SECTION_HEADER_SIZE);
    }
    debug_assert_eq!(out.len(), header_span);

    // payload 区(8 对齐补零)。
    for (section, stored) in sections.iter().zip(&stored_payloads) {
        let aligned = align_up(out.len(), PAYLOAD_ALIGNMENT);
        out.resize(aligned, 0);
        debug_assert_eq!(out.len() as u64, section.payload_offset);
        out.extend_from_slice(stored);
    }
    debug_assert_eq!(out.len(), total_size);
    Ok(out)
}

/// 解析并完整校验 `.dgc` 字节流(magic/版本/尺寸锁定/保留字段/CRC/段间一致性)。
///
/// # Errors
/// 任何结构校验失败返回 [`DagError::DgcFormat`],带失败点说明。
pub fn read_dgc(bytes: &[u8]) -> DagResult<MeshletDag> {
    let mut cursor = Reader::new(bytes);
    let mut magic = [0u8; 4];
    cursor.read_exact_into(&mut magic)?;
    if magic != MAGIC {
        return Err(DagError::dgc_format(format!("bad magic {magic:?}, expected {MAGIC:?}")));
    }
    let version = cursor.read_u32()?;
    if version != FORMAT_VERSION {
        return Err(DagError::dgc_format(format!("unsupported version {version}, expected {FORMAT_VERSION}")));
    }
    let flags = cursor.read_u32()?;
    if flags & !FLAG_ZLIB != 0 {
        return Err(DagError::dgc_format(format!("unknown flags {flags:#x}")));
    }
    let compressed = flags & FLAG_ZLIB != 0;
    let level_count = cursor.read_u32()? as usize;
    let parent_pair_count = cursor.read_u32()? as usize;
    if level_count == 0 {
        return Err(DagError::dgc_format("zero level count"));
    }
    if parent_pair_count != level_count - 1 {
        return Err(DagError::dgc_format(format!(
            "parent pairs {parent_pair_count} inconsistent with {level_count} levels"
        )));
    }
    let source_vertex_count = cursor.read_u32()? as usize;
    let source_triangle_count = cursor.read_u32()? as usize;
    let max_vertices = cursor.read_u32()?;
    let max_triangles = cursor.read_u32()?;
    let total_size = cursor.read_u64()? as usize;
    let reserved = cursor.read_bytes(20)?;
    if reserved.iter().any(|&b| b != 0) {
        return Err(DagError::dgc_format("header reserved bytes must be zero"));
    }
    if total_size != bytes.len() {
        return Err(DagError::dgc_format(format!(
            "size lock mismatch: header says {total_size}, file is {}",
            bytes.len()
        )));
    }
    if max_vertices > MESHLET_MAX_VERTICES_LIMIT || max_triangles > MESHLET_MAX_TRIANGLES_LIMIT {
        return Err(DagError::dgc_format(
            "cluster limits exceed schema caps (file from a newer build?)",
        ));
    }

    let section_count = level_count + parent_pair_count;
    let header_span = FILE_HEADER_SIZE + SECTION_HEADER_SIZE * section_count;
    if bytes.len() < header_span {
        return Err(DagError::dgc_format(format!(
            "truncated: {} bytes < header span {header_span}",
            bytes.len()
        )));
    }

    let mut levels: Vec<DagLevel> = Vec::with_capacity(level_count);
    let mut parents_by_level: Vec<Vec<u32>> = Vec::with_capacity(parent_pair_count);
    for index in 0..section_count {
        let header_base = FILE_HEADER_SIZE + SECTION_HEADER_SIZE * index;
        let mut header = Reader::new(&bytes[header_base..header_base + SECTION_HEADER_SIZE]);
        let kind = header.read_u32()?;
        let level_index = header.read_u32()?;
        let error = header.read_f64()?;
        let mut counts = [0u32; 8];
        for count in &mut counts {
            *count = header.read_u32()?;
        }
        let raw_size = header.read_u64()? as usize;
        let stored_size = header.read_u64()? as usize;
        let payload_offset = header.read_u64()? as usize;
        let crc = header.read_u32()?;
        let reserved_a = header.read_u32()?;
        let reserved_b = header.read_u32()?;
        let reserved_c = header.read_u32()?;
        if reserved_a != 0 || reserved_b != 0 || reserved_c != 0 {
            return Err(DagError::dgc_format("section reserved bytes must be zero"));
        }
        if !payload_offset.is_multiple_of(PAYLOAD_ALIGNMENT) {
            return Err(DagError::dgc_format("payload offset must be 8-byte aligned"));
        }
        if payload_offset.checked_add(stored_size).is_none_or(|end| end > bytes.len()) {
            return Err(DagError::dgc_format(format!(
                "section {index} payload [{payload_offset}, {} ) exceeds file size {}",
                payload_offset + stored_size,
                bytes.len()
            )));
        }
        let stored = &bytes[payload_offset..payload_offset + stored_size];
        let raw: Vec<u8> = if compressed {
            decode_zlib(stored, raw_size)?
        } else {
            if stored_size != raw_size {
                return Err(DagError::dgc_format(format!(
                    "section {index}: uncompressed stored size {stored_size} != raw size {raw_size}"
                )));
            }
            stored.to_vec()
        };
        if raw.len() != raw_size {
            return Err(DagError::dgc_format(format!(
                "section {index}: raw size {} != header {raw_size}",
                raw.len()
            )));
        }
        let actual_crc = crc32c(&raw);
        if actual_crc != crc {
            return Err(DagError::dgc_format(format!(
                "section {index} crc mismatch: file {crc:#010x}, computed {actual_crc:#010x}"
            )));
        }

        match kind {
            SECTION_KIND_LEVEL => {
                let mut payload = Reader::new(&raw);
                let [position_count, index_count, descriptor_count, remap_count, local_tri_count, bounds_count, source_tri_count, span_count] =
                    counts;
                let expected_raw = 4 * (position_count + index_count + descriptor_count + remap_count
                    + local_tri_count + bounds_count + source_tri_count + span_count)
                    as u64;
                if expected_raw != raw_size as u64 {
                    return Err(DagError::dgc_format(format!(
                        "level section {level_index}: counts imply {expected_raw} bytes, header says {raw_size}"
                    )));
                }
                let positions = payload.read_f32_vec(position_count as usize)?;
                let indices = payload.read_u32_vec(index_count as usize)?;
                let descriptors = payload.read_u32_vec(descriptor_count as usize)?;
                let vertex_remap = payload.read_u32_vec(remap_count as usize)?;
                let local_triangle_indices = payload.read_u32_vec(local_tri_count as usize)?;
                let bounds = payload.read_f32_vec(bounds_count as usize)?;
                let source_triangles = payload.read_u32_vec(source_tri_count as usize)?;
                let cluster_source_spans = payload.read_u32_vec(span_count as usize)?;
                if payload.remaining() != 0 {
                    return Err(DagError::dgc_format(format!(
                        "level section {level_index}: {} trailing bytes",
                        payload.remaining()
                    )));
                }
                // 结构不变量:段表长度 == 簇数,前缀和与 indices 一致。
                if descriptor_count / 4 != span_count / 2 {
                    return Err(DagError::dgc_format(format!(
                        "level section {level_index}: {} span pairs inconsistent with {} meshlets",
                        span_count / 2,
                        descriptor_count / 4
                    )));
                }
                if position_count % 3 != 0 || index_count % 3 != 0 {
                    return Err(DagError::dgc_format(format!(
                        "level section {level_index}: position/index counts must be triples"
                    )));
                }
                let mut expected_start = 0u32;
                for span in cluster_source_spans.chunks_exact(2) {
                    if span[0] != expected_start || span[1] < span[0] {
                        return Err(DagError::dgc_format(format!(
                            "level section {level_index}: cluster source spans not a prefix-sum chain"
                        )));
                    }
                    expected_start = span[1];
                }
                if expected_start != index_count / 3 {
                    return Err(DagError::dgc_format(format!(
                        "level section {level_index}: spans cover {} triangles, indices have {}",
                        expected_start,
                        index_count / 3
                    )));
                }
                for &index in &indices {
                    if index >= position_count / 3 {
                        return Err(DagError::dgc_format(format!(
                            "level section {level_index}: index {index} out of vertex range"
                        )));
                    }
                }
                levels.push(DagLevel {
                    level: level_index,
                    error,
                    positions,
                    indices,
                    meshlet_count: descriptor_count as usize / 4,
                    max_vertices,
                    max_triangles,
                    descriptors,
                    vertex_remap,
                    local_triangle_indices,
                    bounds,
                    source_triangles,
                    cluster_source_spans,
                });
            }
            SECTION_KIND_PARENTS => {
                // 段顺序合同:parents 段必须出现在全部 level 段之后。
                if levels.len() != level_count {
                    return Err(DagError::dgc_format(
                        "parents section encountered before all level sections (order contract violated)",
                    ));
                }
                let fine = level_index as usize;
                if fine >= level_count - 1 {
                    return Err(DagError::dgc_format(format!(
                        "parents section references level {fine} as fine side, but last level is {}",
                        level_count - 1
                    )));
                }
                let mut payload = Reader::new(&raw);
                let parents = payload.read_u32_vec(counts[0] as usize)?;
                if payload.remaining() != 0 {
                    return Err(DagError::dgc_format("parents section has trailing bytes"));
                }
                let fine_clusters = levels[fine].meshlet_count;
                if parents.len() != fine_clusters {
                    return Err(DagError::dgc_format(format!(
                        "parents section for level {fine}: {} entries, fine level has {fine_clusters} clusters",
                        parents.len()
                    )));
                }
                let coarse_count = levels[fine + 1].meshlet_count;
                for (cluster, &parent) in parents.iter().enumerate() {
                    if parent != NO_PARENT && parent as usize >= coarse_count {
                        return Err(DagError::dgc_format(format!(
                            "parents section for level {fine}: cluster {cluster} parent {parent} out of range"
                        )));
                    }
                }
                parents_by_level.push(parents);
            }
            other => {
                return Err(DagError::dgc_format(format!("unknown section kind {other}")));
            }
        }
    }
    if levels.len() != level_count || parents_by_level.len() != parent_pair_count {
        return Err(DagError::dgc_format("section count mismatch after parse"));
    }
    // 顶层一致性:level 0 尺寸与文件头一致。
    if levels[0].positions.len() / 3 != source_vertex_count
        || levels[0].indices.len() / 3 != source_triangle_count
    {
        return Err(DagError::dgc_format(
            "level 0 geometry size disagrees with file header",
        ));
    }
    Ok(MeshletDag { levels, parents_by_level })
}

// —— 内部工具 ——

struct SectionRecord {
    kind: u32,
    level: u32,
    error: f64,
    counts: [usize; 8],
    raw: Vec<u8>,
    payload_offset: u64,
}

fn align_up(value: usize, alignment: usize) -> usize {
    value.div_ceil(alignment) * alignment
}

fn extend_le_u32(out: &mut Vec<u8>, values: &[u32]) {
    for &value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }
}

fn extend_le_u64(out: &mut Vec<u8>, values: &[u64]) {
    for &value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }
}

fn extend_le_f32(out: &mut Vec<u8>, values: &[f32]) {
    for &value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }
}

fn extend_le_f64(out: &mut Vec<u8>, values: &[f64]) {
    for &value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }
}

/// 顺序字节读取器(边界检查集中在一处)。
struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    fn read_bytes(&mut self, len: usize) -> DagResult<&'a [u8]> {
        let end = self.pos.checked_add(len).ok_or_else(|| DagError::dgc_format("size overflow"))?;
        if end > self.bytes.len() {
            return Err(DagError::dgc_format(format!(
                "truncated: need {len} bytes at offset {}, only {} remain",
                self.pos,
                self.bytes.len() - self.pos
            )));
        }
        let slice = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn read_exact_into(&mut self, out: &mut [u8]) -> DagResult<()> {
        let slice = self.read_bytes(out.len())?;
        out.copy_from_slice(slice);
        Ok(())
    }

    fn read_u32(&mut self) -> DagResult<u32> {
        let slice = self.read_bytes(4)?;
        Ok(u32::from_le_bytes(slice.try_into().expect("4 bytes")))
    }

    fn read_u64(&mut self) -> DagResult<u64> {
        let slice = self.read_bytes(8)?;
        Ok(u64::from_le_bytes(slice.try_into().expect("8 bytes")))
    }

    fn read_f64(&mut self) -> DagResult<f64> {
        Ok(f64::from_bits(self.read_u64()?))
    }

    fn read_u32_vec(&mut self, count: usize) -> DagResult<Vec<u32>> {
        let slice = self.read_bytes(count * 4)?;
        Ok(slice
            .chunks_exact(4)
            .map(|c| u32::from_le_bytes(c.try_into().expect("4 bytes")))
            .collect())
    }

    fn read_f32_vec(&mut self, count: usize) -> DagResult<Vec<f32>> {
        let slice = self.read_bytes(count * 4)?;
        Ok(slice
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes(c.try_into().expect("4 bytes")))
            .collect())
    }

    fn remaining(&self) -> usize {
        self.bytes.len() - self.pos
    }
}

/// zlib 解压并锁定目标尺寸(解压炸弹防护:输出超过 `raw_size` 即拒绝)。
fn decode_zlib(data: &[u8], raw_size: usize) -> DagResult<Vec<u8>> {
    use std::io::Read;
    let decoder = flate2::read::ZlibDecoder::new(data);
    let mut out = Vec::with_capacity(raw_size.min(1 << 28));
    decoder
        .take(raw_size as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|e| DagError::dgc_format(format!("zlib decode failed: {e}")))?;
    if out.len() != raw_size {
        return Err(DagError::dgc_format(format!(
            "zlib payload size {} != header raw size {raw_size}",
            out.len()
        )));
    }
    Ok(out)
}

/// CRC32C(Castagnoli,iSCSI 反射多项式),查表实现。
#[must_use]
pub fn crc32c(data: &[u8]) -> u32 {
    const POLY: u32 = 0x82f6_3b78; // 反射 0x1EDC6F41
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut table = [0u32; 256];
        for (i, entry) in table.iter_mut().enumerate() {
            let mut crc = i as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 { (crc >> 1) ^ POLY } else { crc >> 1 };
            }
            *entry = crc;
        }
        table
    });
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc = (crc >> 8) ^ table[((crc ^ u32::from(byte)) & 0xFF) as usize];
    }
    crc ^ 0xFFFF_FFFF
}

impl DagLevel {
    /// 该层簇顶点上限(构建参数,随层持久化)。
    #[must_use]
    pub fn max_vertices(&self) -> u32 {
        self.max_vertices
    }

    /// 该层簇三角形上限(构建参数,随层持久化)。
    #[must_use]
    pub fn max_triangles(&self) -> u32 {
        self.max_triangles
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dag::{build_meshlet_dag, DagOptions};
    use crate::types::IndexedGeometry;

    fn sphere_geometry(segments: usize, rings: usize) -> IndexedGeometry {
        let (positions, indices) = crate::simplify::test_support::test_sphere(segments, rings);
        IndexedGeometry { positions, indices }
    }

    fn sample_dag() -> MeshletDag {
        build_meshlet_dag(&sphere_geometry(24, 12), &DagOptions { levels: Some(4), ..Default::default() })
            .expect("dag")
    }

    #[test]
    fn roundtrip_all_levels_bit_exact() {
        let dag = sample_dag();
        for compress in [true, false] {
            let bytes = write_dgc(&dag, &DgcWriteOptions { compress }).expect("write");
            let back = read_dgc(&bytes).expect("read");
            assert_eq!(back.levels.len(), dag.levels.len());
            for (a, b) in dag.levels.iter().zip(&back.levels) {
                assert_eq!(a.level, b.level);
                assert_eq!(a.error.to_bits(), b.error.to_bits());
                assert_eq!(a.positions, b.positions);
                assert_eq!(a.indices, b.indices);
                assert_eq!(a.descriptors, b.descriptors);
                assert_eq!(a.vertex_remap, b.vertex_remap);
                assert_eq!(a.local_triangle_indices, b.local_triangle_indices);
                assert_eq!(a.bounds, b.bounds);
                assert_eq!(a.source_triangles, b.source_triangles);
                assert_eq!(a.cluster_source_spans, b.cluster_source_spans);
            }
            assert_eq!(back.parents_by_level, dag.parents_by_level);
        }
    }

    #[test]
    fn truncated_file_is_rejected() {
        let bytes = write_dgc(&sample_dag(), &DgcWriteOptions::default()).expect("write");
        assert!(read_dgc(&bytes[..bytes.len() - 1]).is_err());
        assert!(read_dgc(&bytes[..40]).is_err());
    }

    #[test]
    fn corrupted_byte_detected_by_crc() {
        let mut bytes = write_dgc(&sample_dag(), &DgcWriteOptions::default()).expect("write");
        let last = bytes.len() - 1;
        bytes[last] ^= 0xFF;
        assert!(read_dgc(&bytes).is_err());
    }

    #[test]
    fn bad_magic_rejected() {
        let mut bytes = write_dgc(&sample_dag(), &DgcWriteOptions::default()).expect("write");
        bytes[0] = b'X';
        let err = read_dgc(&bytes).unwrap_err();
        assert!(err.to_string().contains("bad magic"));
    }

    #[test]
    fn nonempty_reserved_must_be_zero() {
        let mut bytes = write_dgc(&sample_dag(), &DgcWriteOptions::default()).expect("write");
        bytes[0x30] = 1; // header reserved 区
        let err = read_dgc(&bytes).unwrap_err();
        assert!(err.to_string().contains("reserved"));
    }

    #[test]
    fn empty_dag_rejected() {
        let empty = MeshletDag { levels: vec![], parents_by_level: vec![] };
        assert!(write_dgc(&empty, &DgcWriteOptions::default()).is_err());
    }

    #[test]
    fn compression_shrinks_or_ties() {
        let dag = sample_dag();
        let raw = write_dgc(&dag, &DgcWriteOptions { compress: false }).expect("raw");
        let zipped = write_dgc(&dag, &DgcWriteOptions { compress: true }).expect("zip");
        assert!(zipped.len() <= raw.len(), "zlib should not inflate this payload");
    }

    #[test]
    fn crc32c_known_vector() {
        // iSCSI 标准测试向量:"123456789" -> 0xE3069283
        assert_eq!(crc32c(b"123456789"), 0xE306_9283);
    }
}
