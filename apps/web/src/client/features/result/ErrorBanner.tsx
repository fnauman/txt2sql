import { friendlyError } from '../../format';

export function ErrorBanner({ error }: { error: string }) {
  const friendly = friendlyError(error);
  return (
    <div className="error-banner" role="alert">
      <span>{friendly}</span>
      {friendly !== error && (
        <details className="error-detail">
          <summary>Technical details</summary>
          <pre>{error}</pre>
        </details>
      )}
    </div>
  );
}
