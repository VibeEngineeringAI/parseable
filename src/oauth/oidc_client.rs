use actix_web::http::header::HeaderMap;
use async_trait::async_trait;
use openid::{Bearer, Options, Token};
use url::Url;

use crate::{
    handlers::http::{API_BASE_PATH, API_VERSION},
    oauth::provider::{OAuthProvider, OAuthSession, ProviderClaims, ProviderUserInfo},
    oidc::{Claims, DiscoveredClient, OpenidConfig},
    rbac::user::OAuth,
};

/// Wraps the OpenID Connect `DiscoveredClient`.
///
/// Stores the original `OpenidConfig` and the redirect suffix so that it can
/// reconnect (rotating the JWKS) inside `exchange_code` without any outside
/// help.
#[derive(Debug)]
pub struct GlobalClient {
    client: DiscoveredClient,
    /// Original config – cloned and used to reconnect on JWKS rotation.
    config: OpenidConfig,
    /// `"api/v1/o/code"` – the path appended to the base URL for the
    /// redirect URI when re-discovering.
    redirect_suffix: String,
}

impl GlobalClient {
    pub fn new(client: DiscoveredClient, config: OpenidConfig, redirect_suffix: String) -> Self {
        Self {
            client,
            config,
            redirect_suffix,
        }
    }
}

#[async_trait]
impl OAuthProvider for GlobalClient {
    fn auth_url(&self, scope: &str, state: Option<String>) -> Url {
        self.client.auth_url(&Options {
            scope: Some(scope.to_string()),
            state,
            ..Default::default()
        })
    }

    /// Exchange an authorization code for the full session, handling JWKS
    /// rotation transparently: if `decode_token` fails with the cached client,
    /// a fresh discovery is performed and decoding is retried once.
    async fn exchange_code(&mut self, code: &str) -> Result<OAuthSession, anyhow::Error> {
        let bearer = self.client.request_token(code).await?;
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
        Ok(self.client.refresh_token(boxed, scope).await?)
    }

    async fn refresh_session(
        &mut self,
        oauth: &OAuth,
        scope: Option<&str>,
        _headers: HeaderMap,
    ) -> Result<OAuthSession, anyhow::Error> {
        anyhow::ensure!(
            oauth.issuer.as_deref() == Some(self.config.issuer.as_str()),
            "OIDC issuer binding changed; reauthenticate"
        );
        anyhow::ensure!(
            oauth
                .bearer
                .as_ref()
                .and_then(|token| token.refresh_token.as_ref())
                .is_some(),
            "OIDC refresh token unavailable; reauthenticate"
        );
        let bearer = self
            .client
            .refresh_token(Box::new(oauth.clone()), scope)
            .await?;
        // Never reuse old groups if the refresh response omits its ID token.
        let session = self.verified_session(bearer).await?;
        anyhow::ensure!(
            session.claims.sub == oauth.user_info.sub,
            "OIDC subject changed during refresh"
        );
        Ok(session)
    }

    fn logout_url(&self) -> Option<Url> {
        self.client.config().end_session_endpoint.clone()
    }
}

impl GlobalClient {
    async fn verified_session(
        &mut self,
        bearer: openid::Bearer,
    ) -> Result<OAuthSession, anyhow::Error> {
        let mut token: Token<Claims> = bearer.into();
        let id_token = token.id_token.as_mut().ok_or_else(|| {
            anyhow::anyhow!("OIDC provider did not return an id_token; reauthenticate")
        })?;
        if self.client.decode_token(id_token).is_err() {
            // Rotate JWKS once. Avoid logging token error details or credentials.
            self.client = self.config.clone().connect(&self.redirect_suffix).await?;
            self.client.decode_token(id_token)?;
        }
        self.client.validate_token(id_token, None, None)?;
        let raw = id_token.payload()?.clone();
        anyhow::ensure!(
            raw.standard.iss == self.config.issuer,
            "Unexpected OIDC issuer"
        );
        let groups = crate::oauth::authorization::parse_groups(raw.other.get("groups"))?;
        let userinfo_raw = self.client.request_userinfo(&token).await?;
        crate::oauth::authorization::validate_subjects(
            &raw.standard.sub,
            userinfo_raw.sub.as_deref(),
        )?;
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

/// Runs OIDC discovery and wraps the result in a `GlobalClient`.
pub async fn connect_oidc(config: OpenidConfig) -> Result<GlobalClient, openid::error::Error> {
    let redirect_suffix = format!("{API_BASE_PATH}/{API_VERSION}/o/code");
    let client = config.clone().connect(&redirect_suffix).await?;
    Ok(GlobalClient::new(client, config, redirect_suffix))
}
