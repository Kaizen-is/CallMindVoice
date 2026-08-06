'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { IconCheck, IconCopy } from '@/components/icons';

export function CopyField({
  label,
  value,
  mono = true,
  className,
}: {
  label?: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard API needs a secure context; fall back to a selection copy.
      const el = document.createElement('textarea');
      el.value = value;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      el.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className={className}>
      {label && <div className="mb-1 text-[12px] font-medium text-ink-2">{label}</div>}
      <div className="flex items-stretch gap-2">
        <code
          className={cn(
            'min-w-0 flex-1 truncate rounded-[9px] bg-surface px-3 py-2 text-[12.5px] text-ink hairline',
            mono && 'font-mono',
          )}
        >
          {value}
        </code>
        <button
          onClick={() => void copy()}
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-[9px] px-3 text-[12.5px] font-medium transition-colors',
            copied ? 'bg-success text-white' : 'bg-surface-3 text-ink-2 hover:text-ink',
          )}
        >
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
