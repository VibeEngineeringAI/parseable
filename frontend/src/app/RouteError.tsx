import { Component, type ReactNode } from 'react';
import { Link, useRouteError } from 'react-router-dom';
import { LogOut, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button, EmptyState } from '../components/ui';
import { useApp } from './AppProvider';
import { isStaleChunkError } from '../lib/errors';

/**
 * What a page that failed to render shows. Its code may be missing after a
 * deploy, which a reload fixes, so this offers that. Outside the shell it also
 * offers sign-out, which inside the shell is in the top bar.
 */
function ErrorScreen({ error, inShell = false }: { error: unknown; inShell?: boolean }) {
  const { mode, client } = useApp();
  const stale = isStaleChunkError(error);
  const Element = inShell ? 'div' : 'main';
  return (
    <Element className={inShell ? 'page' : 'page route-error'} role="alert">
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
            {!inShell && mode === 'live' && (
              <Button variant="ghost" onClick={() => void client.logout()}>
                <LogOut size={15} aria-hidden="true" />
                Sign out
              </Button>
            )}
          </div>
        }
      />
    </Element>
  );
}

/** Replaces the router's developer screen when the app fails outside a page. */
export function RouteError() {
  return <ErrorScreen error={useRouteError()} />;
}

type BoundaryProps = { resetKey: string; children: ReactNode };
type BoundaryState = { resetKey: string; failed: boolean; error?: unknown };

/**
 * Shows a page's render error inside the shell, so the navigation and the top
 * bar stay. Navigating, which changes `resetKey`, renders the page again.
 */
export class PageErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { resetKey: this.props.resetKey, failed: false };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { failed: true, error };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState) {
    return props.resetKey === state.resetKey
      ? null
      : { resetKey: props.resetKey, failed: false, error: undefined };
  }

  render() {
    return this.state.failed ? (
      <ErrorScreen error={this.state.error} inShell />
    ) : (
      this.props.children
    );
  }
}
