//! A new HTTPS client pins the complete authorized DNS answer for each request.
//! No shared pool survives DNS/policy changes; redirects, proxies and automatic
//! decompression are disabled. Unsupported compressed responses fail closed.
use super::{
    MAX_CONTEXT_BYTES, MAX_RESPONSE_BYTES, ProviderError,
    destination::{ValidatedDestination, authorize_addresses},
    secrets::ProviderSecret,
};
use async_trait::async_trait;
use ipnet::IpNet;
use reqwest::{
    Client, ClientBuilder,
    header::{AUTHORIZATION, CONTENT_ENCODING, CONTENT_TYPE, HeaderValue},
    redirect::Policy,
};
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use zeroize::Zeroizing;

#[async_trait]
pub trait ProviderTransport: Send + Sync {
    async fn post_json(
        &self,
        destination: &ValidatedDestination,
        secret: &ProviderSecret,
        body: &[u8],
    ) -> Result<Vec<u8>, ProviderError>;
}
#[async_trait]
pub trait AddressResolver: Send + Sync {
    async fn resolve(&self, host: &str, port: u16) -> Result<Vec<IpAddr>, ProviderError>;
}
pub struct SystemAddressResolver;
#[async_trait]
impl AddressResolver for SystemAddressResolver {
    async fn resolve(&self, host: &str, port: u16) -> Result<Vec<IpAddr>, ProviderError> {
        let mut addresses = Vec::new();
        for address in tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| ProviderError::TransportFailed)?
        {
            if !addresses.contains(&address.ip()) {
                addresses.push(address.ip());
            }
            if addresses.len() > 64 {
                return Err(ProviderError::DestinationDenied);
            }
        }
        Ok(addresses)
    }
}
/// CIDRs are immutable operator policy, never supplied by credential clients.
pub struct PinnedHttpsTransport {
    allowed: Vec<IpNet>,
    resolver: Arc<dyn AddressResolver>,
    deadline: Duration,
    #[cfg(test)]
    fixture: Option<reqwest::Certificate>,
    #[cfg(test)]
    fixture_loopback: bool,
}
impl PinnedHttpsTransport {
    pub fn new(allowed: Vec<IpNet>, deadline: Duration) -> Result<Self, ProviderError> {
        Self::with_resolver(allowed, deadline, Arc::new(SystemAddressResolver))
    }
    pub fn with_resolver(
        allowed: Vec<IpNet>,
        deadline: Duration,
        resolver: Arc<dyn AddressResolver>,
    ) -> Result<Self, ProviderError> {
        if allowed.is_empty()
            || allowed.len() > 64
            || deadline.is_zero()
            || deadline > Duration::from_secs(120)
        {
            return Err(ProviderError::InvalidConfiguration);
        }
        Ok(Self {
            allowed,
            resolver,
            deadline,
            #[cfg(test)]
            fixture: None,
            #[cfg(test)]
            fixture_loopback: false,
        })
    }
    async fn dispatch(
        &self,
        destination: &ValidatedDestination,
        secret: &ProviderSecret,
        body: &[u8],
    ) -> Result<Vec<u8>, ProviderError> {
        if body.is_empty() || body.len() > MAX_CONTEXT_BYTES + 64 * 1024 {
            return Err(ProviderError::InvalidContext);
        }
        let endpoint = destination.endpoint();
        if endpoint.scheme() != "https" {
            return Err(ProviderError::DestinationDenied);
        }
        let host = endpoint
            .host_str()
            .ok_or(ProviderError::DestinationDenied)?;
        let port = endpoint
            .port_or_known_default()
            .ok_or(ProviderError::DestinationDenied)?;
        let addresses = self.resolver.resolve(host, port).await?;
        #[cfg(not(test))]
        let addresses = authorize_addresses(&addresses, &self.allowed)?;
        #[cfg(test)]
        let addresses = if self.fixture_loopback {
            // A fixture-only exception. No production API/config can enable it.
            if addresses.is_empty()
                || addresses.len() > 64
                || addresses.iter().any(|ip| !ip.is_loopback())
            {
                return Err(ProviderError::DestinationDenied);
            }
            addresses
        } else {
            authorize_addresses(&addresses, &self.allowed)?
        };
        let sockets: Vec<SocketAddr> = addresses
            .into_iter()
            .map(|ip| SocketAddr::new(ip, port))
            .collect();
        // This dispatch owns its client/pool. DNS cannot be repeated by the
        // connector because the exact hostname is overridden by pinned sockets.
        let builder = pinned_client(host, &sockets, self.deadline);
        #[cfg(test)]
        let builder = if let Some(certificate) = &self.fixture {
            builder.add_root_certificate(certificate.clone())
        } else {
            builder
        };
        let client = builder
            .build()
            .map_err(|_| ProviderError::TransportFailed)?;
        let mut bearer = Zeroizing::new(Vec::with_capacity(secret.bytes().len() + 7));
        bearer.extend_from_slice(b"Bearer ");
        bearer.extend_from_slice(secret.bytes());
        let mut authorization =
            HeaderValue::from_bytes(&bearer).map_err(|_| ProviderError::BindingInvalid)?;
        authorization.set_sensitive(true);
        let mut response = client
            .post(endpoint.clone())
            .header(AUTHORIZATION, authorization)
            .header(CONTENT_TYPE, "application/json")
            .header("Accept", "application/json")
            .header("Accept-Encoding", "identity")
            .body(body.to_vec())
            .send()
            .await
            .map_err(|_| ProviderError::TransportFailed)?;
        if !response.status().is_success() {
            return Err(ProviderError::RequestRejected);
        }
        if response.headers().contains_key(CONTENT_ENCODING) {
            let encodings = response.headers().get_all(CONTENT_ENCODING);
            if encodings.iter().any(|encoding| {
                encoding
                    .to_str()
                    .map_or(true, |value| !value.eq_ignore_ascii_case("identity"))
            }) {
                return Err(ProviderError::InvalidResponse);
            }
        }
        if response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_none_or(|value| value.split(';').next().map(str::trim) != Some("application/json"))
        {
            return Err(ProviderError::InvalidResponse);
        }
        if response
            .content_length()
            .is_some_and(|bytes| bytes > MAX_RESPONSE_BYTES as u64)
        {
            return Err(ProviderError::ResponseTooLarge);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| ProviderError::TransportFailed)?
        {
            append_bounded(&mut bytes, &chunk)?;
        }
        Ok(bytes)
    }
}
fn pinned_client(host: &str, sockets: &[SocketAddr], deadline: Duration) -> ClientBuilder {
    Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(Policy::none())
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .min_tls_version(reqwest::tls::Version::TLS_1_2)
        .connect_timeout(deadline.min(Duration::from_secs(10)))
        .timeout(deadline)
        .pool_max_idle_per_host(0)
        .resolve_to_addrs(host, sockets)
}
fn append_bounded(bytes: &mut Vec<u8>, chunk: &[u8]) -> Result<(), ProviderError> {
    if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(bytes.len()) {
        return Err(ProviderError::ResponseTooLarge);
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}
#[async_trait]
impl ProviderTransport for PinnedHttpsTransport {
    async fn post_json(
        &self,
        destination: &ValidatedDestination,
        secret: &ProviderSecret,
        body: &[u8],
    ) -> Result<Vec<u8>, ProviderError> {
        tokio::time::timeout(self.deadline, self.dispatch(destination, secret, body))
            .await
            .map_err(|_| ProviderError::DeadlineExceeded)?
    }
}

#[cfg(test)]
mod tests {
    use super::super::{ProviderKind, destination::ApprovedDestination};
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct MixedResolver(AtomicUsize);
    #[async_trait]
    impl AddressResolver for MixedResolver {
        async fn resolve(&self, _: &str, _: u16) -> Result<Vec<IpAddr>, ProviderError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(vec![
                "8.8.8.8".parse().unwrap(),
                "127.0.0.1".parse().unwrap(),
            ])
        }
    }
    #[tokio::test]
    async fn mixed_dns_fails_before_connection_and_revalidates_every_dispatch() {
        let resolver = Arc::new(MixedResolver(AtomicUsize::new(0)));
        let transport = PinnedHttpsTransport::with_resolver(
            vec!["0.0.0.0/0".parse().unwrap()],
            Duration::from_secs(1),
            resolver.clone(),
        )
        .unwrap();
        let approved = ApprovedDestination::from_operator_root("https://api.example").unwrap();
        let destination = ValidatedDestination::validate(
            "https://api.example",
            ProviderKind::OpenAiResponses,
            &approved,
            1,
        )
        .unwrap();
        let secret = ProviderSecret::new(b"synthetic-key".to_vec()).unwrap();
        for _ in 0..2 {
            assert_eq!(
                transport.post_json(&destination, &secret, b"{}").await,
                Err(ProviderError::DestinationDenied)
            );
        }
        assert_eq!(resolver.0.load(Ordering::SeqCst), 2);
    }
    struct NeverResolver;
    #[async_trait]
    impl AddressResolver for NeverResolver {
        async fn resolve(&self, _: &str, _: u16) -> Result<Vec<IpAddr>, ProviderError> {
            std::future::pending().await
        }
    }
    #[tokio::test(start_paused = true)]
    async fn dns_deadline_and_stream_limit_are_bounded() {
        let transport = PinnedHttpsTransport::with_resolver(
            vec!["8.8.8.0/24".parse().unwrap()],
            Duration::from_secs(1),
            Arc::new(NeverResolver),
        )
        .unwrap();
        let approved = ApprovedDestination::from_operator_root("https://api.example").unwrap();
        let destination = ValidatedDestination::validate(
            "https://api.example",
            ProviderKind::OpenAiResponses,
            &approved,
            1,
        )
        .unwrap();
        let secret = ProviderSecret::new(b"synthetic-key".to_vec()).unwrap();
        assert_eq!(
            transport.post_json(&destination, &secret, b"{}").await,
            Err(ProviderError::DeadlineExceeded)
        );
        let mut bytes = vec![0; MAX_RESPONSE_BYTES - 2];
        assert!(append_bounded(&mut bytes, b"12").is_ok());
        assert_eq!(
            append_bounded(&mut bytes, b"3"),
            Err(ProviderError::ResponseTooLarge)
        );
        assert_eq!(bytes.len(), MAX_RESPONSE_BYTES);
    }
}

#[cfg(test)]
mod network_tests {
    use super::super::{ProviderKind, destination::ApprovedDestination};
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        sync::oneshot,
    };
    use tokio_rustls::{
        TlsAcceptor,
        rustls::{ServerConfig, crypto::ring, pki_types::PrivatePkcs8KeyDer},
        server::TlsStream,
    };
    const HOST: &str = "keystone.provider.fixture.invalid";
    struct LoopbackResolver;
    #[async_trait]
    impl AddressResolver for LoopbackResolver {
        async fn resolve(&self, host: &str, _: u16) -> Result<Vec<IpAddr>, ProviderError> {
            assert_eq!(host, HOST);
            Ok(vec!["127.0.0.1".parse().unwrap()])
        }
    }
    async fn fixture() -> (
        TcpListener,
        TlsAcceptor,
        reqwest::Certificate,
        ValidatedDestination,
    ) {
        let certificate = rcgen::generate_simple_self_signed(vec![HOST.into()]).unwrap();
        let cert = certificate.cert.der().clone();
        let key = PrivatePkcs8KeyDer::from(certificate.signing_key.serialize_der());
        let config = ServerConfig::builder_with_provider(Arc::new(ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![cert.clone()], key.into())
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("https://{HOST}:{}", listener.local_addr().unwrap().port());
        let approved = ApprovedDestination::from_operator_root(&root).unwrap();
        let destination =
            ValidatedDestination::validate(&root, ProviderKind::OpenAiResponses, &approved, 1)
                .unwrap();
        (
            listener,
            TlsAcceptor::from(Arc::new(config)),
            reqwest::Certificate::from_der(&cert).unwrap(),
            destination,
        )
    }
    fn transport(
        certificate: Option<reqwest::Certificate>,
        deadline: Duration,
    ) -> PinnedHttpsTransport {
        let mut transport = PinnedHttpsTransport::with_resolver(
            vec!["127.0.0.1/32".parse().unwrap()],
            deadline,
            Arc::new(LoopbackResolver),
        )
        .unwrap();
        transport.fixture_loopback = true;
        transport.fixture = certificate;
        transport
    }
    async fn request(listener: TcpListener, acceptor: TlsAcceptor) -> TlsStream<TcpStream> {
        let (socket, _) = listener.accept().await.unwrap();
        let mut stream = acceptor.accept(socket).await.unwrap();
        let mut buffer = vec![];
        let mut byte = [0u8; 1];
        while !buffer.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut byte).await.unwrap();
            buffer.extend_from_slice(&byte);
            assert!(buffer.len() < 8192);
        }
        let headers = std::str::from_utf8(&buffer).unwrap().to_ascii_lowercase();
        assert!(headers.contains("authorization: bearer synthetic-fixture-key\r\n"));
        assert!(headers.contains("accept-encoding: identity\r\n"));
        let length = headers
            .lines()
            .find_map(|line| {
                line.strip_prefix("content-length: ")
                    .and_then(|value| value.parse::<usize>().ok())
            })
            .unwrap();
        assert_eq!(length, 2);
        let mut body = [0; 2];
        stream.read_exact(&mut body).await.unwrap();
        assert_eq!(&body, b"{}");
        stream
    }
    #[tokio::test]
    async fn pinned_tls_checks_certificates_and_does_not_use_system_dns() {
        let (listener, acceptor, certificate, destination) = fixture().await;
        let server = tokio::spawn(async move {
            let mut stream = request(listener, acceptor).await;
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await.unwrap();
        });
        let secret = ProviderSecret::new(b"synthetic-fixture-key".to_vec()).unwrap();
        assert_eq!(
            transport(Some(certificate), Duration::from_secs(5))
                .post_json(&destination, &secret, b"{}")
                .await
                .unwrap(),
            b"{}"
        );
        server.await.unwrap();
        let (listener, acceptor, _, destination) = fixture().await;
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            assert!(
                acceptor.accept(socket).await.is_err(),
                "untrusted certificate must fail handshake"
            );
        });
        assert_eq!(
            transport(None, Duration::from_secs(5))
                .post_json(&destination, &secret, b"{}")
                .await,
            Err(ProviderError::TransportFailed)
        );
        server.await.unwrap();
    }
    #[tokio::test]
    async fn redirects_compression_declared_and_chunked_oversize_fail_closed() {
        let secret = ProviderSecret::new(b"synthetic-fixture-key".to_vec()).unwrap();
        for (reply, expected) in [
            (b"HTTP/1.1 302 Found\r\nLocation: https://never-follow.invalid/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(), ProviderError::RequestRejected),
            (b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_vec(), ProviderError::InvalidResponse),
            (b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: strange\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_vec(), ProviderError::InvalidResponse),
            (format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", MAX_RESPONSE_BYTES + 1).into_bytes(), ProviderError::ResponseTooLarge),
        ] {
            let (listener, acceptor, certificate, destination) = fixture().await;
            let server = tokio::spawn(async move { let mut stream=request(listener, acceptor).await; stream.write_all(&reply).await.unwrap(); });
            assert_eq!(transport(Some(certificate), Duration::from_secs(5)).post_json(&destination, &secret, b"{}").await, Err(expected));
            server.await.unwrap();
        }
        let (listener, acceptor, certificate, destination) = fixture().await;
        let server = tokio::spawn(async move {
            let mut stream = request(listener, acceptor).await;
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await.unwrap();
            let chunk = vec![b'x'; 32768];
            for _ in 0..9 {
                if stream.write_all(b"8000\r\n").await.is_err() {
                    break;
                }
                if stream.write_all(&chunk).await.is_err() {
                    break;
                }
                if stream.write_all(b"\r\n").await.is_err() {
                    break;
                }
            }
            let _ = stream.write_all(b"0\r\n\r\n").await;
        });
        assert_eq!(
            transport(Some(certificate), Duration::from_secs(5))
                .post_json(&destination, &secret, b"{}")
                .await,
            Err(ProviderError::ResponseTooLarge)
        );
        server.await.unwrap();
    }
    #[tokio::test]
    async fn dropping_request_closes_inflight_body_and_deadline_stops_stalled_body() {
        let (listener, acceptor, certificate, destination) = fixture().await;
        let (started_tx, started_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let mut stream = request(listener, acceptor).await;
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n").await.unwrap();
            started_tx.send(()).unwrap();
            let mut byte = [0u8; 1];
            let result = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut byte))
                .await
                .expect("cancelled connection remained open");
            assert!(result.is_err() || result.unwrap() == 0);
        });
        let task = tokio::spawn(async move {
            let secret = ProviderSecret::new(b"synthetic-fixture-key".to_vec()).unwrap();
            transport(Some(certificate), Duration::from_secs(30))
                .post_json(&destination, &secret, b"{}")
                .await
        });
        started_rx.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        server.await.unwrap();
        let (listener, acceptor, certificate, destination) = fixture().await;
        let server = tokio::spawn(async move {
            let mut stream = request(listener, acceptor).await;
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n").await.unwrap();
            let mut byte = [0u8; 1];
            let _ = stream.read(&mut byte).await;
        });
        let secret = ProviderSecret::new(b"synthetic-fixture-key".to_vec()).unwrap();
        let result = transport(Some(certificate), Duration::from_millis(200))
            .post_json(&destination, &secret, b"{}")
            .await;
        assert!(matches!(
            result,
            Err(ProviderError::DeadlineExceeded | ProviderError::TransportFailed)
        ));
        server.await.unwrap();
    }
}
