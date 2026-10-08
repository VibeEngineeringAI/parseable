import { Brain, Database, Globe2, Telescope, Zap } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui';
import { intendedReturnPath } from '../lib/auth';
import { appPath } from '../lib/config';
import { useApp } from './AppProvider';
import { LoginForm } from './LoginForm';

export function LoginPage({ oidcUnavailable = false }: { oidcUnavailable?: boolean }) {
  const { setMode, demoEnabled } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const next = intendedReturnPath(location.search);
  return (
    <main className="auth-page" id="main-section">
      <div className="auth-card">
        <section className="auth-intro" aria-labelledby="auth-intro-title">
          <a className="auth-brand" href={appPath('/login')} aria-label="Parseable login">
            <svg viewBox="0 0 28 28" aria-hidden="true">
              <path
                d="M3 13 13 3M3 21 21 3M7 25 25 7M15 25 25 15"
                fill="none"
                stroke="currentColor"
                strokeWidth="4"
                strokeLinecap="round"
              />
            </svg>
            parseable
          </a>
          <div className="auth-intro-content">
            <h1 id="auth-intro-title">
              Observability
              <br />
              <span>Simplified.</span>
            </h1>
            <p className="auth-tagline">AI Native observability datalake.</p>
            <ul className="auth-benefits">
              <li>
                <Globe2 aria-hidden="true" />
                <span>Petascale ingestion</span>
              </li>
              <li>
                <Brain aria-hidden="true" />
                <span>Natural language interface</span>
              </li>
              <li>
                <Telescope aria-hidden="true" />
                <span>Native OpenTelemetry support</span>
              </li>
              <li>
                <Zap aria-hidden="true" />
                <span>Blazing fast query engine</span>
              </li>
              <li>
                <Database aria-hidden="true" />
                <span>Up to 90% compression with columnar design</span>
              </li>
            </ul>
          </div>
          <p className="auth-footer">Self-hosted workspace · Your infrastructure. Your data.</p>
        </section>
        <section className="auth-content" aria-labelledby="login-title">
          <h2 id="login-title">
            {oidcUnavailable ? 'Single sign-on is not configured' : 'Log in to your account'}
          </h2>
          {oidcUnavailable && (
            <p className="auth-description">
              This server does not have an OAuth provider configured. Sign in with your native
              account or contact your administrator.
            </p>
          )}
          <LoginForm
            returnPath={next}
            onSuccess={() => {
              setMode('live');
              navigate(next, { replace: true });
            }}
          />
          {demoEnabled ? (
            <Button
              className="auth-demo"
              variant="ghost"
              onClick={() => {
                setMode('demo');
                navigate(next, { replace: true });
              }}
            >
              Explore demo data
            </Button>
          ) : (
            <p className="auth-help">Need help? Contact your administrator</p>
          )}
          {oidcUnavailable && (
            <Link
              className="text-link auth-native-link"
              to={`/login?${new URLSearchParams({ next })}`}
            >
              Back to native sign in
            </Link>
          )}
        </section>
      </div>
    </main>
  );
}
