import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
import { Button, Dialog, Input } from '../components/ui';
import { createClient } from '../lib/client';
import { startSso } from '../lib/auth';

export function LoginForm({
  returnPath,
  onSuccess,
  submitLabel = 'Login',
}: {
  returnPath: string;
  onSuccess: () => void;
  submitLabel?: string;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  async function connect(event: FormEvent) {
    event.preventDefault();
    setError('');
    setPending(true);
    try {
      await createClient({ mode: 'live' }).login(username, password, returnPath);
      setPassword('');
      onSuccess();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to sign in');
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <form onSubmit={connect} className="login-form" aria-label="Sign in to Parseable">
        <Input
          label="Username"
          name="username"
          autoComplete="username"
          placeholder="Enter your username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          disabled={pending}
        />
        <div className="password-field">
          <Input
            label="Password"
            name="password"
            type={visible ? 'text' : 'password'}
            autoComplete="current-password"
            placeholder="Enter your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={pending}
          />
          <Button
            className="password-visibility"
            variant="ghost"
            size="icon"
            aria-label={visible ? 'Hide password' : 'Show password'}
            aria-pressed={visible}
            onClick={() => setVisible(!visible)}
          >
            {visible ? <EyeOff size={17} /> : <Eye size={17} />}
          </Button>
        </div>
        <Button className="forgot-password" variant="ghost" onClick={() => setForgot(true)}>
          Forgot password?
        </Button>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <Button variant="primary" type="submit" disabled={pending}>
          {pending ? 'Signing in…' : submitLabel}
        </Button>
        <div className="login-divider">
          <span>OR WITH OAUTH</span>
        </div>
        <Button variant="secondary" onClick={() => startSso(returnPath)} disabled={pending}>
          <KeyRound size={16} aria-hidden="true" />
          Sign in with SSO
        </Button>
      </form>
      <Dialog
        open={forgot}
        onOpenChange={setForgot}
        title="Reset password"
        description="Please contact admin to reset your password"
      >
        <Button variant="primary" onClick={() => setForgot(false)}>
          Got it
        </Button>
      </Dialog>
    </>
  );
}
