//! Stateless provider boundaries; live providers require explicit operator setup.
//!
//! Both interfaces receive the same server-built, frozen direct-parent package;
//! neither has graph access, a remote conversation ID, or an execution capability.

#[path = "providers/decisions.rs"]
pub mod decisions;
#[path = "providers/destination.rs"]
pub mod destination;
#[path = "providers/live.rs"]
pub mod live;
#[path = "providers/secrets.rs"]
pub mod secrets;
#[path = "providers/transport.rs"]
pub mod transport;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::fmt;

pub const MAX_CONTEXT_BYTES: usize = 128 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Jev,
    OpenAiDecisions,
    OpenAiResponses,
    OpenRouterChat,
}

impl ProviderKind {
    pub fn path(self) -> &'static str {
        match self {
            Self::Jev => "v1/systemone",
            Self::OpenAiDecisions => "v1/decisions",
            Self::OpenAiResponses => "v1/responses",
            Self::OpenRouterChat => "v1/chat/completions",
        }
    }

    pub fn model(self) -> &'static str {
        match self {
            Self::Jev => "jev-1.13.0",
            Self::OpenAiDecisions => "gpt-6-luna",
            // Generation always requires a separately validated operator model.
            Self::OpenAiResponses | Self::OpenRouterChat => "",
        }
    }
}

/// No Deserialize implementation: clients cannot supply a frozen context.
#[derive(Clone)]
pub struct FrozenProviderContext {
    serialized: String,
    hash: String,
}

impl fmt::Debug for FrozenProviderContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FrozenProviderContext")
            .field("bytes", &self.serialized.len())
            .finish_non_exhaustive()
    }
}

impl FrozenProviderContext {
    pub fn serialized(&self) -> &str {
        &self.serialized
    }

    pub fn hash(&self) -> &str {
        &self.hash
    }

    // Only Keystone's authorized context builder/coordinator may freeze bytes.
    pub(super) fn freeze(bytes: &[u8], hash: &str) -> Result<Self, ProviderError> {
        if bytes.is_empty() || bytes.len() > MAX_CONTEXT_BYTES || hash.is_empty() {
            return Err(ProviderError::InvalidContext);
        }
        let serialized = std::str::from_utf8(bytes)
            .map_err(|_| ProviderError::InvalidContext)?
            .to_owned();
        Ok(Self {
            serialized,
            hash: hash.to_owned(),
        })
    }
}

impl TryFrom<&super::context::PinnedContext> for FrozenProviderContext {
    type Error = ProviderError;

    fn try_from(context: &super::context::PinnedContext) -> Result<Self, Self::Error> {
        context
            .verify()
            .map_err(|_| ProviderError::InvalidContext)?;
        Self::freeze(&context.bytes, &context.hash)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProviderCapabilities {
    pub generative_available: bool,
    pub decision_available: bool,
    pub credential_entry_available: bool,
    pub context_policy: &'static str,
    pub unavailable_reason: &'static str,
}

pub fn capabilities() -> ProviderCapabilities {
    ProviderCapabilities {
        generative_available: false,
        decision_available: false,
        credential_entry_available: false,
        context_policy: "direct_parent_v1",
        unavailable_reason: "Secure SecretStore and reviewed pinned-address transport are not configured",
    }
}

/// A proposal is untrusted text. The coordinator alone can validate and execute it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelProposal {
    pub explanation: String,
}

#[async_trait]
pub trait ModelProvider: Send + Sync {
    /// Exact nonsecret request endpoint/body for durable dispatch provenance.
    /// Implementations must exclude credentials, credential references and headers.
    fn request_manifest(&self, _context: &FrozenProviderContext) -> Option<serde_json::Value> {
        None
    }

    async fn propose_versioned(
        &self,
        tenant_id: &str,
        _config_revision: u64,
        context: &FrozenProviderContext,
    ) -> Result<ModelProposal, ProviderError> {
        self.propose_for_tenant(tenant_id, context).await
    }
    /// Trusted coordinator identity selects a tenant-bound credential without
    /// adding tenant identity to provider-visible messages.
    async fn propose_for_tenant(
        &self,
        _tenant_id: &str,
        context: &FrozenProviderContext,
    ) -> Result<ModelProposal, ProviderError> {
        self.propose(context).await
    }

    async fn propose(
        &self,
        context: &FrozenProviderContext,
    ) -> Result<ModelProposal, ProviderError>;
}

#[derive(Default)]
pub struct UnavailableModelProvider;

#[async_trait]
impl ModelProvider for UnavailableModelProvider {
    async fn propose(&self, _: &FrozenProviderContext) -> Result<ModelProposal, ProviderError> {
        Err(ProviderError::ProductionUnavailable)
    }
}

/// Errors never interpolate provider response bodies, credentials, or input data.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ProviderError {
    #[error("invalid or oversized frozen context")]
    InvalidContext,
    #[error("invalid decision rubric")]
    InvalidQuestions,
    #[error("invalid provider response")]
    InvalidResponse,
    #[error("provider response exceeds the size limit")]
    ResponseTooLarge,
    #[error("provider destination is not approved")]
    DestinationDenied,
    #[error("provider credential binding is invalid")]
    BindingInvalid,
    #[error("secure secret storage is unavailable")]
    SecretStoreUnavailable,
    #[error("invalid provider configuration")]
    InvalidConfiguration,
    #[error("provider transport failed")]
    TransportFailed,
    #[error("provider request deadline exceeded")]
    DeadlineExceeded,
    #[error("provider rejected the request")]
    RequestRejected,
    #[error("production inference is disabled pending secure storage and transport")]
    ProductionUnavailable,
}

#[cfg(test)]
pub struct FixtureModelProvider {
    pub proposal: ModelProposal,
}

#[cfg(test)]
#[async_trait]
impl ModelProvider for FixtureModelProvider {
    async fn propose(&self, _: &FrozenProviderContext) -> Result<ModelProposal, ProviderError> {
        Ok(self.proposal.clone())
    }
}
