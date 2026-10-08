import { useLocation, useNavigate } from 'react-router-dom';
import { Button, EmptyState, Spinner } from '../ui';
import { useApp } from '../../app/AppProvider';
import { ApiError } from '../../lib/client';
export function QueryState({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error?: Error;
  retry?: () => void;
}) {
  const { mode, setMode, demoEnabled } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  if (loading)
    return (
      <div role="status" className="loading-state">
        <Spinner />
        Loading data…
      </div>
    );
  if (!error) return null;
  const unauthorized = error instanceof ApiError && error.status === 401;
  const forbidden = error instanceof ApiError && error.status === 403;
  return (
    <div role="alert">
      <EmptyState
        title={
          forbidden
            ? 'Permission denied'
            : unauthorized
              ? 'Sign in required'
              : 'Could not load data'
        }
        description={
          forbidden
            ? `${error.message}. Ask your administrator for access to this resource.`
            : error.message
        }
        action={
          <div className="inline">
            {unauthorized ? (
              <Button
                onClick={() =>
                  navigate(
                    `/login?${new URLSearchParams({ next: `${location.pathname}${location.search}${location.hash}` })}`,
                  )
                }
              >
                Sign in
              </Button>
            ) : (
              retry && (
                <Button variant="secondary" onClick={retry}>
                  Try again
                </Button>
              )
            )}
            {mode === 'live' && demoEnabled && !unauthorized && !forbidden && (
              <Button onClick={() => setMode('demo')}>Explore demo data</Button>
            )}
          </div>
        }
      />
    </div>
  );
}
