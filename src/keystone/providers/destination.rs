//! Pure destination policy. The HTTPS transport resolves and pins these grants.
use super::{ProviderError, ProviderKind};
use ipnet::IpNet;
use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use url::Url;

/// Operator-created grant: an exact origin and gateway prefix, not a suffix match.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovedDestination {
    origin: String,
    prefix: String,
    port: u16,
}

impl ApprovedDestination {
    /// Call only from operator policy loading, never tenant/client input.
    pub fn from_operator_root(root: &str) -> Result<Self, ProviderError> {
        let parsed = parse_root(root)?;
        Ok(Self {
            origin: parsed.origin().ascii_serialization(),
            prefix: parsed.path().trim_end_matches('/').to_owned(),
            port: parsed
                .port_or_known_default()
                .ok_or(ProviderError::DestinationDenied)?,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DestinationBinding {
    origin: String,
    prefix: String,
    port: u16,
    policy_revision: u64,
}

/// Canonical destination with a fixed protocol operation path.
#[derive(Clone, Debug)]
pub struct ValidatedDestination {
    endpoint: Url,
    binding: DestinationBinding,
}

impl ValidatedDestination {
    pub fn validate(
        root: &str,
        kind: ProviderKind,
        approved: &ApprovedDestination,
        policy_revision: u64,
    ) -> Result<Self, ProviderError> {
        let mut parsed = parse_root(root)?;
        let binding = DestinationBinding {
            origin: parsed.origin().ascii_serialization(),
            prefix: parsed.path().trim_end_matches('/').to_owned(),
            port: parsed
                .port_or_known_default()
                .ok_or(ProviderError::DestinationDenied)?,
            policy_revision,
        };
        if binding.origin != approved.origin
            || binding.prefix != approved.prefix
            || binding.port != approved.port
        {
            return Err(ProviderError::DestinationDenied);
        }
        parsed.set_path(&format!("{}/{}", binding.prefix, kind.path()));
        Ok(Self {
            endpoint: parsed,
            binding,
        })
    }

    pub fn endpoint(&self) -> &Url {
        &self.endpoint
    }
    pub fn binding(&self) -> &DestinationBinding {
        &self.binding
    }

    /// Origin, prefix, port or policy changes invalidate existing credentials.
    pub fn check_binding(&self, binding: &DestinationBinding) -> Result<(), ProviderError> {
        if &self.binding == binding {
            Ok(())
        } else {
            Err(ProviderError::BindingInvalid)
        }
    }
}

fn parse_root(raw: &str) -> Result<Url, ProviderError> {
    let root = raw.trim().trim_end_matches('/');
    // Validate BEFORE Url's dot-segment normalization. Conservatively reject all
    // percent escapes in roots so gateways cannot interpret encoded separators.
    if root.is_empty()
        || root.contains(['%', '\\', '?', '#'])
        || root
            .bytes()
            .any(|c| c.is_ascii_control() || c.is_ascii_whitespace())
    {
        return Err(ProviderError::DestinationDenied);
    }
    let authority_and_path = root
        .strip_prefix("https://")
        .ok_or(ProviderError::DestinationDenied)?;
    let path = authority_and_path
        .split_once('/')
        .map(|(_, path)| path)
        .unwrap_or("");
    if authority_and_path
        .split('/')
        .next()
        .unwrap_or("")
        .contains('@')
        || path.split('/').any(|segment| {
            segment == "." || segment == ".." || (segment.is_empty() && !path.is_empty())
        })
        || path.split('/').next_back() == Some("v1")
        || path.ends_with("v1/systemone")
        || path.ends_with("v1/decisions")
        || path.ends_with("v1/responses")
        || path.ends_with("v1/chat/completions")
    {
        return Err(ProviderError::DestinationDenied);
    }
    let parsed = Url::parse(root).map_err(|_| ProviderError::DestinationDenied)?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(ProviderError::DestinationDenied);
    }
    Ok(parsed)
}

/// Every resolved A/AAAA address needs its OWN matching operator CIDR grant.
/// Returned addresses are the complete validated set used by the pinned transport.
pub fn authorize_addresses(
    addresses: &[IpAddr],
    allowed: &[IpNet],
) -> Result<Vec<IpAddr>, ProviderError> {
    if addresses.is_empty() || addresses.len() > 64 {
        return Err(ProviderError::DestinationDenied);
    }
    for address in addresses {
        // IPv4-mapped IPv6 must be checked under IPv4 policy, never bypass it.
        let normalized = match address {
            IpAddr::V6(ip) => ip.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(*address),
            _ => *address,
        };
        if forbidden(normalized)
            || !allowed
                .iter()
                .any(|network| grants_address(network, normalized))
        {
            return Err(ProviderError::DestinationDenied);
        }
    }
    Ok(addresses.to_vec())
}

/// Private networks reached by public DNS are a rebinding target. A catch-all
/// such as `0.0.0.0/0` that merely contains a private address is not a grant for
/// it; only an operator CIDR lying entirely inside that private block is.
fn grants_address(network: &IpNet, address: IpAddr) -> bool {
    if !network.contains(&address) {
        return false;
    }
    match private_block(address) {
        Some(block) => block.contains(network),
        None => true,
    }
}

fn private_block(address: IpAddr) -> Option<IpNet> {
    const BLOCKS: [&str; 4] = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"];
    BLOCKS
        .iter()
        .map(|block| block.parse::<IpNet>().expect("static private block"))
        .find(|block| block.contains(&address))
}

fn forbidden(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            a == 0
                || a == 127
                || a >= 224
                || (a == 169 && b == 254)
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 0 && c == 2)
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            // IPv4-mapped forms were normalized to IPv4 by the caller. Everything
            // else in ::/8 is IETF-reserved and never a global unicast destination:
            // unspecified, loopback, IPv4-compatible ::/96 and the SIIT
            // IPv4-translated ::ffff:0:0:0/96 (e.g. ::ffff:0:7f00:1), which a
            // translator would deliver to an unchecked IPv4 address.
            (segments[0] & 0xff00) == 0
                // RFC 6666 discard-only prefix: no legitimate provider lives there.
                || segments[..4] == [0x100, 0, 0, 0]
                || ip.is_multicast()
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] & 0xffc0) == 0xfec0
                || (segments[0] == 0x2001 && segments[1] == 0xdb8)
                || (segments[0] == 0x64 && segments[1] == 0xff9b)
                // AWS's IPv6 metadata endpoint and IPv4 transition mechanisms
                // must not bypass IPv4 loopback/link-local destination policy.
                || ip == "fd00:ec2::254".parse::<std::net::Ipv6Addr>().unwrap()
                || segments[0] == 0x2002
                || (segments[0] == 0x2001 && segments[1] == 0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_operation_paths_and_bindings() {
        for (kind, path) in [
            (ProviderKind::Jev, "systemone"),
            (ProviderKind::OpenAiDecisions, "decisions"),
            (ProviderKind::OpenAiResponses, "responses"),
            (ProviderKind::OpenRouterChat, "chat/completions"),
        ] {
            let grant =
                ApprovedDestination::from_operator_root("https://gateway.example:8443/prefix")
                    .unwrap();
            let destination = ValidatedDestination::validate(
                " https://gateway.example:8443/prefix/ ",
                kind,
                &grant,
                1,
            )
            .unwrap();
            assert_eq!(
                destination.endpoint().as_str(),
                format!("https://gateway.example:8443/prefix/v1/{path}")
            );
            assert!(destination.check_binding(destination.binding()).is_ok());
            let revised = ValidatedDestination::validate(
                "https://gateway.example:8443/prefix",
                kind,
                &grant,
                2,
            )
            .unwrap();
            assert_eq!(
                revised.check_binding(destination.binding()),
                Err(ProviderError::BindingInvalid)
            );
            for changed in [
                "https://evil.example:8443/prefix",
                "https://gateway.example/prefix",
                "https://gateway.example:8443/other",
            ] {
                assert!(ValidatedDestination::validate(changed, kind, &grant, 1).is_err());
            }
        }
    }

    #[test]
    fn ambiguous_roots_are_rejected_before_normalization() {
        for root in [
            "http://api.example",
            "https://key@api.example",
            "https://api.example?key=x",
            "https://api.example#x",
            "https://api.example/a/../b",
            "https://api.example/./b",
            "https://api.example/%2e%2e",
            "https://api.example/%2f",
            "https://api.example/a\\b",
            "https://api.example/a//b",
            "https://api.example/v1",
            "https://api.example/v1/decisions",
            "https://api.example/v1/systemone",
            "https://api.example/v1/responses",
            "https://api.example/v1/chat/completions",
        ] {
            assert!(
                ApprovedDestination::from_operator_root(root).is_err(),
                "{root}"
            );
        }
    }

    #[test]
    fn every_dns_address_requires_its_own_grant() {
        let public: IpAddr = "8.8.8.8".parse().unwrap();
        let private: IpAddr = "10.0.0.9".parse().unwrap();
        let allow = ["8.8.8.0/24".parse().unwrap()];
        assert!(authorize_addresses(&[public], &allow).is_ok());
        assert!(authorize_addresses(&[public, private], &allow).is_err());
        assert!(authorize_addresses(&[private, public], &allow).is_err());
        assert!(authorize_addresses(&[private], &["10.0.0.0/24".parse().unwrap()]).is_ok());
        assert!(authorize_addresses(&[], &allow).is_err());
        for ip in [
            "127.0.0.1",
            "169.254.169.254",
            "100.100.100.200",
            "::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "fd00:ec2::254",
            "2002:7f00:0001::1",
            "2001::1",
            "::ffff:0:7f00:1",
            "::ffff:0:a9fe:a9fe",
            "100::1",
        ] {
            assert!(
                authorize_addresses(
                    &[ip.parse().unwrap()],
                    &["0.0.0.0/0".parse().unwrap(), "::/0".parse().unwrap()]
                )
                .is_err()
            );
        }
    }

    fn nets(values: &[&str]) -> Vec<IpNet> {
        values.iter().map(|v| v.parse().unwrap()).collect()
    }
    fn ips(values: &[&str]) -> Vec<IpAddr> {
        values.iter().map(|v| v.parse().unwrap()).collect()
    }

    #[test]
    fn catch_all_cidrs_never_grant_private_addresses() {
        let catch_all = nets(&["0.0.0.0/0", "::/0"]);
        assert!(authorize_addresses(&ips(&["8.8.8.8", "2606:4700::1"]), &catch_all).is_ok());
        for private in [
            "10.0.0.9",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.1",
            "fc00::1",
            "fd12:3456::1",
            "::ffff:10.0.0.9",
            "::ffff:192.168.0.1",
        ] {
            assert!(
                authorize_addresses(&ips(&[private]), &catch_all).is_err(),
                "{private}"
            );
            // Mixed DNS answers: one private record denies the whole set.
            for order in [
                ips(&["8.8.8.8", "2606:4700::1", private]),
                ips(&[private, "2606:4700::1", "8.8.8.8"]),
            ] {
                assert!(
                    authorize_addresses(&order, &catch_all).is_err(),
                    "{private}"
                );
            }
        }
        // Broad grants that span beyond a private block are not narrow opt-ins,
        // and an extra explicit grant for one private range covers only that range.
        for broad in [
            "10.0.0.0/7",
            "172.0.0.0/8",
            "192.0.0.0/8",
            "fc00::/6",
            "::ffff:0:0/96",
        ] {
            let allowed = nets(&[broad, "8.8.8.0/24"]);
            for private in ["10.0.0.9", "172.16.0.1", "192.168.1.1", "fc00::1"] {
                assert!(
                    authorize_addresses(&ips(&[private]), &allowed).is_err(),
                    "{broad} {private}"
                );
            }
        }
        let mixed = nets(&["0.0.0.0/0", "::/0", "10.1.0.0/16"]);
        assert!(authorize_addresses(&ips(&["8.8.8.8", "10.1.2.3"]), &mixed).is_ok());
        assert!(authorize_addresses(&ips(&["10.1.2.3", "10.2.0.1"]), &mixed).is_err());
        assert!(authorize_addresses(&ips(&["10.1.2.3", "192.168.0.1"]), &mixed).is_err());
        assert!(authorize_addresses(&ips(&["10.1.2.3", "fd00::1"]), &mixed).is_err());
        // Private-only grants still need forbidden-range checks and per-address grants.
        assert!(authorize_addresses(&ips(&["8.8.8.8"]), &nets(&["10.0.0.0/8"])).is_err());
    }

    #[test]
    fn explicit_narrow_private_grants_remain_operator_opt_in() {
        for (address, grant) in [
            ("10.0.0.9", "10.0.0.0/24"),
            ("10.200.1.1", "10.0.0.0/8"),
            ("172.20.0.5", "172.16.0.0/12"),
            ("172.20.0.5", "172.20.0.5/32"),
            ("192.168.7.7", "192.168.7.0/24"),
            ("fd12:3456::1", "fd12:3456::/32"),
            ("fc00::1", "fc00::/7"),
            ("::ffff:10.0.0.9", "10.0.0.0/24"),
        ] {
            assert!(
                authorize_addresses(&ips(&[address]), &nets(&[grant])).is_ok(),
                "{address} {grant}"
            );
            // Order of grants does not matter, and a catch-all does not dilute it.
            assert!(
                authorize_addresses(&ips(&[address]), &nets(&["0.0.0.0/0", "::/0", grant])).is_ok(),
                "{address} {grant}"
            );
        }
        let allowed = nets(&["10.0.0.0/24", "fd00::/64", "8.8.8.0/24"]);
        assert!(authorize_addresses(&ips(&["10.0.0.9", "fd00::9", "8.8.8.8"]), &allowed).is_ok());
        assert!(authorize_addresses(&ips(&["10.0.0.9", "fd00:1::9"]), &allowed).is_err());
        // Loopback and metadata ranges stay denied even with exact grants.
        for (address, grant) in [
            ("127.0.0.1", "127.0.0.0/8"),
            ("169.254.169.254", "169.254.169.254/32"),
            ("fd00:ec2::254", "fd00:ec2::/32"),
        ] {
            assert!(authorize_addresses(&ips(&[address]), &nets(&[grant])).is_err());
        }
    }

    #[test]
    fn ipv4_translated_and_reserved_ipv6_forms_are_denied_under_any_grant() {
        // Each address is denied under a catch-all, a wide IPv6 grant and its
        // own exact /128: no CIDR can opt into these forms.
        for address in [
            // SIIT IPv4-translated ::ffff:0:0:0/96: loopback, metadata, private, public.
            "::ffff:0:7f00:1",
            "::ffff:0:a9fe:a9fe",
            "::ffff:0:a00:9",
            "::ffff:0:808:808",
            // IPv4-compatible ::/96 and the rest of the IETF-reserved ::/8.
            "::7f00:1",
            "::808:808",
            "::1:0:0:1",
            "ff::1",
            // RFC 6666 discard-only.
            "100::1",
            "100::ffff:ffff:ffff:ffff",
        ] {
            let ip: IpAddr = address.parse().unwrap();
            for grant in [
                nets(&["0.0.0.0/0", "::/0"]),
                nets(&["::/8"]),
                nets(&["::ffff:0:0:0/96"]),
                nets(&["100::/64"]),
                vec![IpNet::from(ip)],
            ] {
                assert!(
                    authorize_addresses(&[ip], &grant).is_err(),
                    "{address} {grant:?}"
                );
                // A forbidden form denies the whole answer set.
                let mixed = [nets(&["8.8.8.0/24"]), grant.clone()].concat();
                assert!(authorize_addresses(&ips(&["8.8.8.8"]), &mixed).is_ok());
                assert!(
                    authorize_addresses(&[ips(&["8.8.8.8"]), vec![ip]].concat(), &mixed).is_err(),
                    "{address} {grant:?}"
                );
            }
        }
        // Unchanged: global IPv6, ordinary IPv4-mapped conversion and narrow grants.
        for (address, grant) in [
            ("2606:4700::1", "::/0"),
            ("2001:4860:4860::8888", "2001:4860::/32"),
            ("2001:4860:4860::8888", "2001:4860:4860::8888/128"),
            ("::ffff:8.8.8.8", "8.8.8.0/24"),
            ("::ffff:8.8.8.8", "0.0.0.0/0"),
            ("::ffff:10.0.0.9", "10.0.0.0/24"),
            ("101::1", "::/0"),
            ("100:0:0:1::1", "::/0"),
        ] {
            assert!(
                authorize_addresses(&ips(&[address]), &nets(&[grant])).is_ok(),
                "{address} {grant}"
            );
        }
        // Mapped addresses are judged as IPv4 only: an IPv6 grant never admits them,
        // and mapped loopback/metadata stay forbidden under exact IPv4 grants.
        assert!(authorize_addresses(&ips(&["::ffff:8.8.8.8"]), &nets(&["::/0"])).is_err());
        for (address, grant) in [
            ("::ffff:127.0.0.1", "127.0.0.0/8"),
            ("::ffff:169.254.169.254", "169.254.169.254/32"),
            ("::ffff:10.0.0.9", "::ffff:10.0.0.0/120"),
        ] {
            assert!(
                authorize_addresses(&ips(&[address]), &nets(&[grant])).is_err(),
                "{address} {grant}"
            );
        }
    }
}
