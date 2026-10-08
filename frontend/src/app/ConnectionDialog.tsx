import { useLocation } from 'react-router-dom';
import { Button, Dialog } from '../components/ui';
import { useApp } from './AppProvider';
import { LoginForm } from './LoginForm';
export function ConnectionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { setMode, mode, client, demoEnabled } = useApp();
  const location = useLocation();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Connect to Parseable"
      description="Sign in to the Parseable server serving this workspace."
    >
      {open && (
        <LoginForm
          returnPath={`${location.pathname}${location.search}${location.hash}`}
          submitLabel="Connect"
          onSuccess={() => {
            setMode('live');
            onOpenChange(false);
          }}
        />
      )}
      <div className="connection-actions">
        {demoEnabled && (
          <Button
            variant="secondary"
            onClick={() => {
              setMode('demo');
              onOpenChange(false);
            }}
          >
            Explore demo data
          </Button>
        )}
        {mode === 'live' && (
          <Button variant="ghost" onClick={() => void client.logout()}>
            Sign out of server
          </Button>
        )}
      </div>
    </Dialog>
  );
}
