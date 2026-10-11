import { Link, useRouteError } from 'react-router-dom';
import { LogOut, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button, EmptyState } from '../components/ui';
import { useApp } from './AppProvider';

/**
 * Replaces the router's developer screen when a page fails to render. The
 * page's code may be missing after a deploy, which a reload fixes, so this
 * offers that and keeps sign-out reachable.
 */
export function RouteError() {
  const error = useRouteError();
  const { mode, client } = useApp();
  const stale =
    error instanceof TypeError &&
    /dynamically imported module|module script|Failed to fetch/i.test(error.message);
  return (
    <main className="page route-error" role="alert">
      <EmptyState
        icon={<TriangleAlert size={24} strokeWidth={1.5} />}
        title={stale ? 'This page could not be loaded' : 'Something went wrong'}
        description={
          stale
            ? 'Parseable may have been updated since this tab was opened. Reload to get the latest version.'
            : error instanceof Error
              ? error.message
              : 'The page failed to render.'
        }
        action={
          <div className="inline">
            <Button onClick={() => window.location.reload()}>
              <RefreshCw size={15} aria-hidden="true" />
              Reload
            </Button>
            <Link className="ui-button" data-variant="secondary" to="/" reloadDocument>
              Back to overview
            </Link>
            {mode === 'live' && (
              <Button variant="ghost" onClick={() => void client.logout()}>
                <LogOut size={15} aria-hidden="true" />
                Sign out
              </Button>
            )}
          </div>
        }
      />
    </main>
  );
}
