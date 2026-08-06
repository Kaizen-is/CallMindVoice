import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { IconTrendDown, IconTrendUp } from '@/components/icons';

/**
 * A KPI tile. Deliberately quiet: the number is the loudest thing on it, the
 * delta is secondary, and colour is reserved for genuine signal.
 */
export function StatCard({
  label,
  value,
  sub,
  delta,
  deltaGood,
  icon,
  spark,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  delta?: number | null;
  /** Which direction counts as improvement. Default: up is good. */
  deltaGood?: 'up' | 'down';
  icon?: ReactNode;
  spark?: number[];
  className?: string;
}) {
  const good = deltaGood ?? 'up';
  const positive = delta != null && (good === 'up' ? delta >= 0 : delta <= 0);

  return (
    <div className={cn('rounded-[14px] bg-surface p-5 shadow-e1 hairline', className)}>
      <div className="flex items-start justify-between gap-3">
        <span className="text-[12.5px] font-medium text-ink-3">{label}</span>
        {icon && <span className="text-ink-3">{icon}</span>}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-[27px] leading-none font-semibold tracking-[-0.03em] text-ink tabular">
          {value}
        </span>
        {delta != null && Number.isFinite(delta) && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 text-[12px] font-medium tabular',
              positive ? 'text-success' : 'text-danger',
            )}
          >
            {delta >= 0 ? <IconTrendUp size={13} /> : <IconTrendDown size={13} />}
            {Math.abs(delta).toFixed(0)}%
          </span>
        )}
      </div>
      {sub && <div className="mt-1.5 text-[12px] text-ink-3">{sub}</div>}
      {spark && spark.length > 1 && <Sparkline data={spark} positive={positive} />}
    </div>
  );
}

function Sparkline({ data, positive }: { data: number[]; positive: boolean }) {
  const w = 120;
  const h = 28;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = `M ${points.join(' L ')}`;
  const area = `${line} L ${w},${h} L 0,${h} Z`;
  const stroke = positive ? 'rgb(var(--success))' : 'rgb(var(--brand))';

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="mt-3 h-7 w-full"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`spark-${positive ? 'p' : 'n'}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#spark-${positive ? 'p' : 'n'})`} />
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
