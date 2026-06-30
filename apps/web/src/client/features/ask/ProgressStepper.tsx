import { Check, Loader2 } from 'lucide-react';

import { STAGE_LABELS, STAGE_ORDER, type StageStatus, type PipelineStage } from '../../hooks/useQueryStream';

export function ProgressStepper({ stages }: { stages: Record<PipelineStage, StageStatus> }) {
  return (
    <ol className="progress-stepper" aria-label="Query progress" aria-live="polite">
      {STAGE_ORDER.map((stage) => {
        const status = stages[stage];
        return (
          <li key={stage} className={`progress-step ${status}`}>
            <span className="progress-icon" aria-hidden="true">
              {status === 'done' ? <Check size={13} /> : status === 'active' ? <Loader2 size={13} className="spin" /> : <span className="progress-dot" />}
            </span>
            <span className="progress-label">{STAGE_LABELS[stage]}</span>
          </li>
        );
      })}
    </ol>
  );
}
