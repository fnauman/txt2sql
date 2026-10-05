import { errorStageLabel, friendlyError } from '../../format';
import type { ErrorStage, ValidationLayer } from '../../types';

export function ErrorBanner({
  error,
  stage = null,
  code = null,
  layer = null,
}: {
  error: string;
  stage?: ErrorStage | null;
  code?: string | null;
  layer?: ValidationLayer | null;
}) {
  const friendly = friendlyError(error, { code, stage, layer });
  const stageLabel = errorStageLabel(stage);
  return (
    <div className="error-banner" role="alert">
      {stageLabel && (
        <span className={`error-stage error-stage-${stage}`} title={code ? `Failed at: ${stageLabel} (${code})` : `Failed at: ${stageLabel}`}>
          {stageLabel}
        </span>
      )}
      <span>{friendly}</span>
      {friendly !== error && (
        <details className="error-detail">
          <summary>Technical details</summary>
          <pre>{code ? `[${code}] ${error}` : error}</pre>
        </details>
      )}
    </div>
  );
}
