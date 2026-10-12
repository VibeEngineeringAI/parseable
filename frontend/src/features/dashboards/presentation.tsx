import { Minimize2 } from 'lucide-react';
import { Button } from '../../components/ui';
import './presentation.css';

export function DashboardPresentationControls({ onExit }: { onExit: () => void }) {
  return (
    <div className="dashboard-presentation-controls" data-dashboard-export-ignore>
      <span className="muted">Presentation · Esc to exit</span>
      <Button data-presentation-exit onClick={onExit}>
        <Minimize2 size={16} aria-hidden="true" /> Exit presentation
      </Button>
    </div>
  );
}
