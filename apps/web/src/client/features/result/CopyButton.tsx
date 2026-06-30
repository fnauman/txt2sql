import { useState } from 'react';
import { CheckCircle2, Copy } from 'lucide-react';

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button className="icon-button small" type="button" onClick={copy} title={label} aria-label={label} disabled={!value}>
      {copied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
    </button>
  );
}
