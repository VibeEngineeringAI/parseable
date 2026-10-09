import { Badge } from '../../components/ui';

export function LabelChips({ labels }: { labels: Record<string, string> }) {
  const entries = Object.entries(labels)
    .filter(([key]) => key !== '__name__')
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? (
    <div className="alerts-tags">
      {entries.map(([key, value]) => (
        <Badge className="alerts-label-chip" key={key}>
          {key}={value}
        </Badge>
      ))}
    </div>
  ) : (
    <span className="muted">{labels.__name__ ?? 'No labels'}</span>
  );
}
