//! P1-13 受控 HTTP/1.1 Transport:std::net 零新依赖的请求-响应绑定。
//! 受控边界(fail-closed,不满足即 Down,不做隐式协商):
//! - 仅 `http://` 明文;TLS/订阅式长连接是后续切片,显式拒绝;
//! - HTTP/1.1 单请求单响应;`Content-Length` 必须存在(chunked/无长度拒绝);
//! - 重定向(3xx)拒绝;非 2xx 一律 `Unavailable`,带状态码;
//! - 响应头与响应体各有硬上限;读写超时映射 `Timeout`。
//!
//! 凭据边界:本模块不持有凭据;需要认证时由宿主在构造 config 前把
//! 凭据编入固定头部(如受控网关令牌),不落盘、不进日志。
//!
//! 接收面:`Transport` 合同只覆盖 connect/send/close;HTTP 响应体缓存在
//! 本实现内部,宿主在 `send` 返回 `Up` 后调用 `take_response` 取走并
//! 泵入 `DataSourceMachine::on_receive`。`take_response` 一次取净,幂等取空。

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use super::contract::{Transport, TransportFailure, TransportOutcome};

/// 单响应头区上限;超限按协议违规拒绝,防止恶意服务器无限发头。
const MAX_HEADER_BYTES: usize = 64 * 1024;
/// 单响应体上限:与数据源缓存预算同量级的独立防线。
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpTransportConfig {
    pub host: String,
    pub port: u16,
    pub path: String,
    pub method: HttpMethod,
    /// 连接与读写的单一超时;0 视为配置错误。
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
}

impl HttpMethod {
    fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
        }
    }
}

impl HttpTransportConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.host.is_empty() || self.host.contains(['/', ' ', '\0']) {
            return Err("invalid http host".into());
        }
        if !self.path.starts_with('/') || self.path.contains([' ', '\r', '\n', '\0']) {
            return Err("invalid http path".into());
        }
        if self.timeout_ms == 0 || self.timeout_ms > 60_000 {
            return Err("http timeout out of bounds".into());
        }
        Ok(())
    }
}

pub struct HttpTransport {
    config: HttpTransportConfig,
    stream: Option<TcpStream>,
    response: Option<Vec<u8>>,
}

impl HttpTransport {
    pub fn new(config: HttpTransportConfig) -> Result<Self, String> {
        config.validate()?;
        Ok(Self {
            config,
            stream: None,
            response: None,
        })
    }

    /// 取走最近一次 send 的响应体;无未取响应时返回 None。
    pub fn take_response(&mut self) -> Option<Vec<u8>> {
        self.response.take()
    }

    fn request_bytes(&self, body: &[u8]) -> Vec<u8> {
        let method = self.config.method.as_str();
        // 请求头全部为固定字段,路径与 host 已在构造时校验过无注入字符。
        format!(
            "{} {} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\nContent-Length: {}\r\nAccept: application/octet-stream\r\n\r\n",
            method,
            self.config.path,
            self.config.host,
            self.config.port,
            body.len()
        )
        .into_bytes()
        .into_iter()
        .chain(body.iter().copied())
        .collect()
    }
}

impl Transport for HttpTransport {
    fn connect(&mut self) -> TransportOutcome {
        if self.stream.is_some() {
            return TransportOutcome::Up;
        }
        let addr = match (self.config.host.as_str(), self.config.port)
            .to_socket_addrs()
            .map(|mut addrs| addrs.next())
        {
            Ok(Some(addr)) => addr,
            Ok(None) => {
                return TransportOutcome::Down(TransportFailure::Unavailable(
                    "host unresolved".into(),
                ));
            }
            Err(error) => {
                return TransportOutcome::Down(TransportFailure::Unavailable(format!(
                    "resolve: {error}"
                )));
            }
        };
        match TcpStream::connect(addr) {
            Ok(stream) => {
                let timeout = Duration::from_millis(self.config.timeout_ms);
                let _ = stream.set_read_timeout(Some(timeout));
                let _ = stream.set_write_timeout(Some(timeout));
                let _ = stream.set_nodelay(true);
                self.stream = Some(stream);
                TransportOutcome::Up
            }
            Err(error) => {
                TransportOutcome::Down(TransportFailure::Unavailable(format!("connect: {error}")))
            }
        }
    }

    fn send(&mut self, bytes: &[u8]) -> TransportOutcome {
        let request = self.request_bytes(bytes);
        let Some(stream) = self.stream.as_mut() else {
            return TransportOutcome::Down(TransportFailure::Unavailable("not connected".into()));
        };
        self.response = None;
        if let Err(error) = stream.write_all(&request) {
            self.close();
            return TransportOutcome::Down(TransportFailure::Unavailable(format!(
                "write: {error}"
            )));
        }
        let mut head = Vec::new();
        let mut buffer = [0u8; 4096];
        let header_end;
        loop {
            match stream.read(&mut buffer) {
                Ok(0) => {
                    self.close();
                    return TransportOutcome::Down(TransportFailure::Unavailable(
                        "connection closed in headers".into(),
                    ));
                }
                Ok(count) => {
                    head.extend_from_slice(&buffer[..count]);
                    if head.len() > MAX_HEADER_BYTES {
                        self.close();
                        return TransportOutcome::Down(TransportFailure::Unavailable(
                            "header budget exceeded".into(),
                        ));
                    }
                    if let Some(position) = find_header_end(&head) {
                        header_end = position;
                        break;
                    }
                }
                Err(error) => {
                    self.close();
                    let failure = timeout_or_unavailable(&error);
                    return TransportOutcome::Down(failure);
                }
            }
        }
        let (status, headers, reason) = match parse_head(&head[..header_end]) {
            Some(parsed) => parsed,
            None => {
                self.close();
                return TransportOutcome::Down(TransportFailure::Unavailable(
                    "malformed response head".into(),
                ));
            }
        };
        let mut body = head[header_end..].to_vec();
        let Some(length) = content_length(&headers) else {
            self.close();
            return TransportOutcome::Down(TransportFailure::Unavailable(
                "content-length required; chunked and streaming responses are rejected".into(),
            ));
        };
        if length > MAX_BODY_BYTES {
            self.close();
            return TransportOutcome::Down(TransportFailure::Unavailable(
                "body budget exceeded".into(),
            ));
        }
        while body.len() < length {
            match stream.read(&mut buffer) {
                Ok(0) => {
                    self.close();
                    return TransportOutcome::Down(TransportFailure::Unavailable(
                        "connection closed in body".into(),
                    ));
                }
                Ok(count) => body.extend_from_slice(&buffer[..count]),
                Err(error) => {
                    self.close();
                    return TransportOutcome::Down(timeout_or_unavailable(&error));
                }
            }
        }
        if body.len() > length {
            body.truncate(length);
        }
        self.close();
        if !(200..300).contains(&status) {
            let phrase = if (300..400).contains(&status) {
                format!("redirect {status} rejected: {reason}")
            } else {
                format!("status {status}: {reason}")
            };
            return TransportOutcome::Down(TransportFailure::Unavailable(phrase));
        }
        self.response = Some(body);
        TransportOutcome::Up
    }

    fn close(&mut self) {
        // 关闭即丢弃半开连接;HTTP/1.1 Connection: close 下每次 send 后都关闭,
        // 下次 send 前宿主必须重新 connect(状态机 Retrying→connect 轨迹覆盖)。
        self.stream = None;
    }
}

fn timeout_or_unavailable(error: &std::io::Error) -> TransportFailure {
    match error.kind() {
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => TransportFailure::Timeout,
        _ => TransportFailure::Unavailable(format!("read: {error}")),
    }
}

fn find_header_end(head: &[u8]) -> Option<usize> {
    head.windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| position + 4)
}

/// 解析后的响应头:状态码、小写化的头字段表与原因短语。
type ResponseHead = (u16, Vec<(String, String)>, String);

fn parse_head(head: &[u8]) -> Option<ResponseHead> {
    let text = std::str::from_utf8(head).ok()?;
    let mut lines = text.split("\r\n");
    let status_line = lines.next()?;
    let mut parts = status_line.split(' ');
    let _version = parts.next()?;
    let status = parts.next()?.parse::<u16>().ok()?;
    let reason = parts.collect::<Vec<_>>().join(" ");
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (name, value) = line.split_once(':')?;
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
    }
    Some((status, headers, reason))
}

fn content_length(headers: &[(String, String)]) -> Option<usize> {
    let transfer = headers
        .iter()
        .find(|(name, _)| name == "transfer-encoding")
        .map(|(_, value)| value.clone());
    if transfer.is_some() {
        return None;
    }
    let length = headers.iter().find(|(name, _)| name == "content-length")?;
    length.1.parse::<usize>().ok()
}
