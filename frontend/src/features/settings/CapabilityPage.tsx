import { Link } from 'react-router-dom';
import { LockKeyhole, Sparkles, Shield } from 'lucide-react';
import { Badge, Card, CardBody, EmptyState } from '../../components/ui';
import { PageHeader } from '../../components/explorer/PageHeader';
import { settingsCapabilities, type SettingsCapability } from '../../lib/settingsCapabilities';
import './settings.css';

/** Local informational content: it deliberately makes no API or secret requests. */
export function CapabilityPage({
  feature,
  id,
  demo = false,
}: {
  feature: SettingsCapability;
  id?: string;
  demo?: boolean;
}) {
  const scope = settingsCapabilities[feature];
  const Icon = feature === 'keystone' ? Sparkles : feature === 'llm' ? LockKeyhole : Shield;
  return (
    <div className="page settings-capability-page">
      <PageHeader title={scope.title} description={scope.description} />
      {demo && (
        <p className="settings-demo-notice" role="status">
          Sample workspace: this capability is not simulated. No settings are changed.
        </p>
      )}
      <Card>
        <CardBody>
          <div className="inline">
            <Badge tone="warning">Unavailable in native UI</Badge>
          </div>
          <EmptyState
            title={scope.unavailable}
            description={scope.explanation}
            icon={<Icon size={28} strokeWidth={1.5} />}
          />
          {feature === 'keystone' && id && (
            <p className="settings-scope-note">
              This investigation has not been loaded. Its existence and your access have not been
              verified.
            </p>
          )}
          <p className="settings-scope-note">
            Ask your deployment administrator which API supports this feature.
          </p>
        </CardBody>
      </Card>
      <nav className="settings-related" aria-label="Related pages">
        {feature === 'keystone' ? (
          <Link to="/sql-editor">Explore data with SQL</Link>
        ) : (
          <Link to="/team">Manage users and roles</Link>
        )}
        {feature !== 'llm' && <Link to="/settings/llm-key">LLM settings</Link>}
        <Link to="/settings/network-access">Network access</Link>
        {feature !== 'keystone' && <Link to="/keystone">Keystone</Link>}
      </nav>
    </div>
  );
}
