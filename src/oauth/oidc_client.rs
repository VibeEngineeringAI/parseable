use std::sync::Arc;

use actix_web::http::header::HeaderMap;
use async_trait::async_trait;
use openid::{Bearer, OAuth2ErrorCode, Options, Token, error::ClientError};
use parking_lot::RwLock;
use url::Url;

use crate::{
    handlers::http::{API_BASE_PATH, API_VERSION},
    oauth::provider::{
        AuthorizationRevoked, OAuthProvider, OAuthSession, ProviderClaims, ProviderUserInfo,
    },
    oidc::{Claims, DiscoveredClient, OpenidConfig},
    rbac::user::OAuth,
};

/// Wraps the OpenID Connect `DiscoveredClient`.
///
/// Stores the original `OpenidConfig` and the redirect suffix so that it can
/// reconnect (rotating the JWKS) inside `exchange_code` without any outside
/// help. Network calls run against a snapshot of the client, so a rotation
/// only holds the inner lock for the swap itself.
#[derive(Debug)]
pub struct GlobalClient {
    client: RwLock<Arc<DiscoveredClient>>,
    /// Original config – cloned and used to reconnect on JWKS rotation.
    config: OpenidConfig,
    /// `"api/v1/o/code"` – the path appended to the base URL for the
    /// redirect URI when re-discovering.
    redirect_suffix: String,
}

impl GlobalClient {
    pub fn new(client: DiscoveredClient, config: OpenidConfig, redirect_suffix: String) -> Self {
        Self {
            client: RwLock::new(Arc::new(client)),
            config,
            redirect_suffix,
        }
    }

    fn client(&self) -> Arc<DiscoveredClient> {
        self.client.read().clone()
    }
}

#[async_trait]
impl OAuthProvider for GlobalClient {
    fn auth_url(&self, scope: &str, state: Option<String>) -> Url {
        self.client().auth_url(&Options {
            scope: Some(scope.to_string()),
            state,
            ..Default::default()
        })
    }

    /// Exchange an authorization code for the full session, handling JWKS
    /// rotation transparently: if `decode_token` fails with the cached client,
    /// a fresh discovery is performed and decoding is retried once.
    async fn exchange_code(&self, code: &str) -> Result<OAuthSession, anyhow::Error> {
        let bearer = self.client().request_token(code).await?;
        self.verified_session(bearer).await
    }

    async fn refresh_token(
        &self,
        oauth: &OAuth,
        scope: Option<&str>,
        _headers: HeaderMap,
    ) -> Result<Bearer, anyhow::Error> {
        // Box the clone so we can pass it to the openid client.
        let boxed: Box<OAuth> = Box::new(oauth.clone());
        Ok(self.client().refresh_token(boxed, scope).await?)
    }

    async fn refresh_session(
        &self,
        oauth: &OAuth,
        scope: Option<&str>,
        _headers: HeaderMap,
    ) -> Result<OAuthSession, anyhow::Error> {
        if oauth.issuer.as_deref() != Some(self.config.issuer.as_str()) {
            return Err(
                AuthorizationRevoked::new("OIDC issuer binding changed; reauthenticate").into(),
            );
        }
        if oauth
            .bearer
            .as_ref()
            .and_then(|token| token.refresh_token.as_ref())
            .is_none()
        {
            return Err(AuthorizationRevoked::new(
                "OIDC refresh token unavailable; reauthenticate",
            )
            .into());
        }
        let bearer = match self
            .client()
            .refresh_token(Box::new(oauth.clone()), scope)
            .await
        {
            Ok(bearer) => bearer,
            // The token endpoint refused the grant, e.g. with `invalid_grant`.
            Err(ClientError::OAuth2(error)) if !transient_oauth_error(&error.error) => {
                return Err(
                    AuthorizationRevoked::new(format!("OIDC refresh refused: {error}")).into(),
                );
            }
            Err(error) => return Err(error.into()),
        };
        // Never reuse old groups if the refresh response omits its ID token.
        let session = self.verified_session(bearer).await?;
        if session.claims.sub != oauth.user_info.sub {
            return Err(AuthorizationRevoked::new("OIDC subject changed during refresh").into());
        }
        Ok(session)
    }

    fn logout_url(&self) -> Option<Url> {
        self.client().config().end_session_endpoint.clone()
    }
}

impl GlobalClient {
    /// Verify a token response. Failures of the provider's assertions are
    /// [`AuthorizationRevoked`]; discovery and userinfo transport failures are not.
    async fn verified_session(
        &self,
        bearer: openid::Bearer,
    ) -> Result<OAuthSession, anyhow::Error> {
        let revoked = |reason: &str| anyhow::Error::from(AuthorizationRevoked::new(reason));
        let mut token: Token<Claims> = bearer.into();
        let id_token = token
            .id_token
            .as_mut()
            .ok_or_else(|| revoked("OIDC provider did not return an id_token; reauthenticate"))?;
        let mut client = self.client();
        if client.decode_token(id_token).is_err() {
            // Rotate JWKS once. Avoid logging token error details or credentials.
            client = Arc::new(self.config.clone().connect(&self.redirect_suffix).await?);
            *self.client.write() = client.clone();
            client
                .decode_token(id_token)
                .map_err(|_| revoked("OIDC ID token signature is invalid"))?;
        }
        client
            .validate_token(id_token, None, None)
            .map_err(|_| revoked("OIDC ID token is invalid"))?;
        let raw = id_token.payload()?.clone();
        if raw.standard.iss != self.config.issuer {
            return Err(revoked("Unexpected OIDC issuer"));
        }
        let groups = crate::oauth::authorization::parse_groups(raw.other.get("groups"))
            .map_err(|error| revoked(&error.to_string()))?;
        let userinfo_raw = client.request_userinfo(&token).await?;
        crate::oauth::authorization::validate_subjects(
            &raw.standard.sub,
            userinfo_raw.sub.as_deref(),
        )
        .map_err(|error| revoked(&error.to_string()))?;
        // The authorization interval is also bounded by the verified ID token.
        let id_lifetime = raw
            .standard
            .exp
            .saturating_sub(chrono::Utc::now().timestamp())
            .max(0) as u64;
        let mut bearer = token.bearer;
        bearer.expires_in = Some(bearer.expires_in.unwrap_or(id_lifetime).min(id_lifetime));
        Ok(OAuthSession {
            bearer,
            claims: ProviderClaims {
                issuer: raw.standard.iss.to_string(),
                sub: Some(raw.standard.sub),
                email: userinfo_raw.email.clone(),
                name: userinfo_raw.name.clone(),
                groups,
                other: raw.other,
            },
            userinfo: ProviderUserInfo {
                sub: userinfo_raw.sub,
                email: userinfo_raw.email,
                name: userinfo_raw.name,
                preferred_username: userinfo_raw.preferred_username,
                picture: userinfo_raw
                    .picture
                    .as_ref()
                    .map(|p| p.as_str().to_string()),
            },
        })
    }
}

/// Error codes a provider uses for availability problems rather than refusals.
/// Anything else from the token endpoint fails closed.
fn transient_oauth_error(code: &OAuth2ErrorCode) -> bool {
    matches!(code, OAuth2ErrorCode::Unrecognized(code)
        if matches!(code.as_str(), "temporarily_unavailable" | "server_error" | "slow_down"))
}

/// Runs OIDC discovery and wraps the result in a `GlobalClient`.
pub async fn connect_oidc(config: OpenidConfig) -> Result<GlobalClient, openid::error::Error> {
    let redirect_suffix = format!("{API_BASE_PATH}/{API_VERSION}/o/code");
    let client = config.clone().connect(&redirect_suffix).await?;
    Ok(GlobalClient::new(client, config, redirect_suffix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_availability_errors_from_the_token_endpoint_are_transient() {
        for code in ["temporarily_unavailable", "server_error", "slow_down"] {
            assert!(transient_oauth_error(&OAuth2ErrorCode::from(code)));
        }
        for code in [
            "invalid_grant",
            "invalid_client",
            "unauthorized_client",
            "access_denied",
        ] {
            assert!(!transient_oauth_error(&OAuth2ErrorCode::from(code)));
        }
    }
}
