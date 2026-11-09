/** Small pieces the model lab's tabs share: formatting and table cells. */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const pct = (n: number | null | undefined, digits = 1) =>
  n == null ? '—' : `${(n * 100).toFixed(digits)}%`;

export const secs = (ms: number | null | undefined) =>
  ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;

export const usd = (n: number | null | undefined) =>
  n == null ? '—' : n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(4)}` : n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;

export function Th({ children, right, first }: { children: ReactNode; right?: boolean; first?: boolean }) {
  return <th className={cn('py-3', first ? 'px-5' : 'px-3', right && 'text-right')}>{children}</th>;
}

export function Td({
  children,
  right,
  first,
  className,
}: {
  children: ReactNode;
  right?: boolean;
  first?: boolean;
  className?: string;
}) {
  return (
    <td
      className={cn(
        'py-3 align-top text-[12.5px] text-ink-2',
        first ? 'px-5' : 'px-3',
        right && 'text-right tabular whitespace-nowrap',
        className,
      )}
    >
      {children}
    </td>
  );
}

export function TableShell({
  minWidth,
  head,
  children,
  cols,
}: {
  minWidth: number;
  head: ReactNode;
  children: ReactNode;
  /** Column count: with it, the first (name) and last (action) columns get fixed widths and the rest share the space equally. */
  cols?: number;
}) {
  return (
    <div className="overflow-x-auto">
      <table className={cn('w-full', cols && 'table-fixed')} style={{ minWidth }}>
        {cols && (
          <colgroup>
            <col style={{ width: '24%' }} />
            {Array.from({ length: cols - 2 }, (_, i) => (
              <col key={i} />
            ))}
            <col style={{ width: 96 }} />
          </colgroup>
        )}
        <thead>
          <tr className="text-left text-[11.5px] font-medium tracking-wide text-ink-3 uppercase hairline-b">{head}</tr>
        </thead>
        <tbody className="divide-y divide-[rgb(var(--line)/var(--line-alpha))]">{children}</tbody>
      </table>
    </div>
  );
}
