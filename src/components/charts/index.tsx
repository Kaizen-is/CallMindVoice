'use client';

/**
 * Chart primitives.
 *
 * Hand-rolled SVG rather than a charting library: it keeps the bundle small,
 * makes every mark spec explicit, and lets the whole set theme from the same
 * CSS variables as the rest of the console.
 *
 * House rules applied throughout:
 *   • one y-axis, never two;
 *   • categorical colours assigned in fixed slot order and never cycled;
 *   • 2px stroke lines, 4px rounded data-ends, a 2px surface gap between
 *     stacked segments and adjacent bars;
 *   • recessive grid and axis ink, values in text tokens rather than series
 *     colour, and a legend whenever more than one series is on screen;
 *   • a hover layer on every plot.
 */

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { translator } from '@/lib/i18n';
import type { UiLocale } from '@/lib/types';

/** BCP-47 tag for date/number formatting from a UI locale (Uzbek Cyrillic
 *  borrows Uzbek Latin's CLDR data). */
export function localeTag(locale: UiLocale | undefined): string {
  switch (locale) {
    case 'ru':
      return 'ru-RU';
    case 'uz':
    case 'uz-Cyrl':
      return 'uz-UZ';
    default:
      return 'en-GB';
  }
}
import { cn, fmtInt } from '@/lib/utils';

const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];
const SEQ = [
  'var(--seq-100)',
  'var(--seq-200)',
  'var(--seq-300)',
  'var(--seq-400)',
  'var(--seq-500)',
  'var(--seq-600)',
  'var(--seq-700)',
];

/* ═══ shared chrome ════════════════════════════════════════════ */

export function ChartFrame({
  title,
  subtitle,
  action,
  legend,
  footnote,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  legend?: Array<{ label: string; color: string }>;
  footnote?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('rounded-[14px] bg-surface p-5 shadow-e1 hairline', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[14.5px] font-semibold text-ink">{title}</h3>
          {subtitle && <p className="mt-0.5 text-[12.5px] text-ink-3">{subtitle}</p>}
        </div>
        {action}
      </div>
      {legend && legend.length > 1 && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {legend.map((l) => (
            <span key={l.label} className="inline-flex items-center gap-1.5 text-[12px] text-ink-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      )}
      <div className="mt-4">{children}</div>
      {footnote && <p className="mt-3 text-[11.5px] leading-relaxed text-ink-3">{footnote}</p>}
    </div>
  );
}

function Tooltip({
  x,
  y,
  width,
  children,
}: {
  x: number;
  y: number;
  width: number;
  children: ReactNode;
}) {
  // Flip to the left of the cursor near the right edge so it never clips.
  const flip = x > width * 0.62;
  return (
    <div
      className="pointer-events-none absolute z-20 min-w-[132px] rounded-[9px] bg-overlay p-2.5 text-[11.5px] shadow-e3 hairline"
      style={{
        left: flip ? undefined : `${x + 12}px`,
        right: flip ? `${width - x + 12}px` : undefined,
        top: `${Math.max(4, y - 12)}px`,
      }}
    >
      {children}
    </div>
  );
}

function TooltipRow({ color, label, value }: { color?: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-px">
      <span className="inline-flex items-center gap-1.5 text-ink-2">
        {color && <span className="h-2 w-2 rounded-[2px]" style={{ background: color }} />}
        {label}
      </span>
      <span className="font-medium text-ink tabular">{value}</span>
    </div>
  );
}

/* ═══ trend (area + line) ══════════════════════════════════════ */

export interface TrendSeries {
  label: string;
  values: number[];
  /** Slot index into the fixed categorical order. */
  slot?: number;
}

/**
 * Value formatting is a token rather than a callback so a Server Component can
 * configure the axis without handing a function across the RSC boundary.
 */
export type ValueFormat = 'int' | 'ms' | 'usd' | 'pct';

const FORMATTERS: Record<ValueFormat, (v: number) => string> = {
  int: (v) => fmtInt(v),
  ms: (v) => `${Math.round(v)}`,
  usd: (v) => `$${v < 10 ? v.toFixed(1) : Math.round(v)}`,
  pct: (v) => `${Math.round(v * 100)}%`,
};

export function TrendChart({
  labels,
  series,
  height = 200,
  valueFormat = 'int',
  yLabel,
  locale,
}: {
  labels: string[];
  series: TrendSeries[];
  height?: number;
  valueFormat?: ValueFormat;
  yLabel?: string;
  locale?: UiLocale;
}) {
  const format = FORMATTERS[valueFormat] ?? FORMATTERS.int;
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const W = 720;
  const H = height;
  const padL = 40;
  const padR = 12;
  const padT = 10;
  const padB = 24;

  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const niceMax = niceCeil(max);
  const n = labels.length;

  const x = (i: number) => padL + (i / Math.max(1, n - 1)) * (W - padL - padR);
  const y = (v: number) => padT + (1 - v / niceMax) * (H - padT - padB);

  const ticks = [0, 0.5, 1].map((f) => Math.round(niceMax * f));

  return (
    <div className="relative" ref={ref}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height }}
        role="img"
        aria-label={`${series.map((s) => s.label).join(', ')} over ${n} days`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          const idx = Math.round(((px - padL) / (W - padL - padR)) * (n - 1));
          setHover(Math.max(0, Math.min(n - 1, idx)));
        }}
      >
        <defs>
          {series.map((s, i) => (
            <linearGradient key={s.label} id={`trend-fill-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SERIES[(s.slot ?? i) % SERIES.length]} stopOpacity="0.20" />
              <stop offset="100%" stopColor={SERIES[(s.slot ?? i) % SERIES.length]} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth="1" />
            <text
              x={padL - 8}
              y={y(t) + 3.5}
              textAnchor="end"
              className="fill-[rgb(var(--text-3))] text-[10px] tabular"
            >
              {format(t)}
            </text>
          </g>
        ))}

        {series.map((s, i) => {
          const color = SERIES[(s.slot ?? i) % SERIES.length];
          const pts = s.values.map((v, j) => `${x(j)},${y(v)}`);
          const line = `M ${pts.join(' L ')}`;
          const area = `${line} L ${x(n - 1)},${y(0)} L ${x(0)},${y(0)} Z`;
          return (
            <g key={s.label}>
              {series.length <= 2 && <path d={area} fill={`url(#trend-fill-${i})`} />}
              <path
                d={line}
                fill="none"
                stroke={color}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          );
        })}

        {hover != null && (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={padT}
              y2={H - padB}
              stroke="var(--axis)"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            {series.map((s, i) => (
              <circle
                key={s.label}
                cx={x(hover)}
                cy={y(s.values[hover] ?? 0)}
                r="4.5"
                fill={SERIES[(s.slot ?? i) % SERIES.length]}
                stroke="rgb(var(--surface))"
                strokeWidth="2"
              />
            ))}
          </g>
        )}

        <line x1={padL} x2={W - padR} y1={H - padB} y2={H - padB} stroke="var(--axis)" strokeWidth="1" />
        {labels.map((l, i) =>
          i % Math.ceil(n / 6) === 0 || i === n - 1 ? (
            <text
              key={l}
              x={x(i)}
              y={H - padB + 15}
              textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
              className="fill-[rgb(var(--text-3))] text-[10px]"
            >
              {shortDay(l)}
            </text>
          ) : null,
        )}
      </svg>

      {hover != null && (
        <Tooltip
          x={(x(hover) / W) * (ref.current?.clientWidth ?? W)}
          y={20}
          width={ref.current?.clientWidth ?? W}
        >
          <div className="mb-1 font-medium text-ink">{longDay(labels[hover], locale)}</div>
          {series.map((s, i) => (
            <TooltipRow
              key={s.label}
              color={SERIES[(s.slot ?? i) % SERIES.length]}
              label={s.label}
              value={format(s.values[hover] ?? 0)}
            />
          ))}
        </Tooltip>
      )}
      {yLabel && <div className="mt-1 text-[11px] text-ink-3">{yLabel}</div>}
    </div>
  );
}

/* ═══ stacked bars ═════════════════════════════════════════════ */

export function StackedBars({
  labels,
  series,
  height = 200,
  locale,
}: {
  labels: string[];
  series: TrendSeries[];
  height?: number;
  locale?: UiLocale;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const W = 720;
  const H = height;
  const padL = 36;
  const padR = 10;
  const padT = 10;
  const padB = 24;

  const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const niceMax = niceCeil(Math.max(1, ...totals));
  const n = labels.length;
  const slotW = (W - padL - padR) / n;
  const barW = Math.max(3, Math.min(24, slotW - 4));
  const scale = (v: number) => (v / niceMax) * (H - padT - padB);

  return (
    <div className="relative" ref={ref}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height }}
        role="img"
        aria-label="Daily call outcomes"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          setHover(Math.max(0, Math.min(n - 1, Math.floor((px - padL) / slotW))));
        }}
      >
        {[0, 0.5, 1].map((f) => {
          const v = Math.round(niceMax * f);
          const yy = padT + (1 - f) * (H - padT - padB);
          return (
            <g key={f}>
              <line x1={padL} x2={W - padR} y1={yy} y2={yy} stroke="var(--grid)" strokeWidth="1" />
              <text
                x={padL - 8}
                y={yy + 3.5}
                textAnchor="end"
                className="fill-[rgb(var(--text-3))] text-[10px] tabular"
              >
                {fmtInt(v)}
              </text>
            </g>
          );
        })}

        {labels.map((_, i) => {
          const cx = padL + i * slotW + slotW / 2;
          let cursor = H - padB;
          return (
            <g key={i} opacity={hover == null || hover === i ? 1 : 0.42}>
              {series.map((s, si) => {
                const v = s.values[i] ?? 0;
                if (v <= 0) return null;
                const h = scale(v);
                cursor -= h;
                const top = cursor;
                // 2px surface gap keeps adjacent segments legible.
                cursor -= 2;
                return (
                  <rect
                    key={s.label}
                    x={cx - barW / 2}
                    y={top}
                    width={barW}
                    height={Math.max(1, h)}
                    rx={si === series.length - 1 ? 3 : 0}
                    fill={SERIES[(s.slot ?? si) % SERIES.length]}
                  />
                );
              })}
            </g>
          );
        })}

        <line x1={padL} x2={W - padR} y1={H - padB} y2={H - padB} stroke="var(--axis)" strokeWidth="1" />
        {labels.map((l, i) =>
          i % Math.ceil(n / 6) === 0 || i === n - 1 ? (
            <text
              key={l}
              x={padL + i * slotW + slotW / 2}
              y={H - padB + 15}
              textAnchor="middle"
              className="fill-[rgb(var(--text-3))] text-[10px]"
            >
              {shortDay(l)}
            </text>
          ) : null,
        )}
      </svg>

      {hover != null && (
        <Tooltip
          x={((padL + hover * slotW + slotW / 2) / W) * (ref.current?.clientWidth ?? W)}
          y={16}
          width={ref.current?.clientWidth ?? W}
        >
          <div className="mb-1 font-medium text-ink">{longDay(labels[hover], locale)}</div>
          {series.map((s, si) => (
            <TooltipRow
              key={s.label}
              color={SERIES[(s.slot ?? si) % SERIES.length]}
              label={s.label}
              value={fmtInt(s.values[hover] ?? 0)}
            />
          ))}
          <div className="mt-1 border-t border-[rgb(var(--line)/var(--line-alpha))] pt-1">
            <TooltipRow label="Total" value={fmtInt(totals[hover])} />
          </div>
        </Tooltip>
      )}
    </div>
  );
}

/* ═══ horizontal ranking ═══════════════════════════════════════ */

export function RankBars({
  rows,
  valueFormat = 'int',
  slot = 0,
  emptyLabel = 'No data yet',
}: {
  rows: Array<{ label: string; value: number; sub?: string }>;
  valueFormat?: ValueFormat;
  slot?: number;
  emptyLabel?: string;
}) {
  const format = FORMATTERS[valueFormat] ?? FORMATTERS.int;
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) {
    return <p className="py-8 text-center text-[13px] text-ink-3">{emptyLabel}</p>;
  }
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.label} className="group">
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-[13px] text-ink">{r.label}</span>
            <span className="shrink-0 text-[12.5px] font-medium text-ink tabular">
              {format(r.value)}
              {r.sub && <span className="ml-1.5 font-normal text-ink-3">{r.sub}</span>}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-[rgb(var(--text)/0.07)]">
            <div
              className="h-full rounded-full transition-[width] duration-500 ease-out"
              style={{
                width: `${(r.value / max) * 100}%`,
                background: SERIES[slot % SERIES.length],
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ═══ heatmap ══════════════════════════════════════════════════ */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function Heatmap({ grid, locale }: { grid: number[][]; locale?: UiLocale }) {
  const t = translator(locale ?? 'en');
  const dayName = (d: number) => t(`dow.short.${d}`, DAY_NAMES[d]);
  const callsWord = t('chart.calls', 'calls');
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null);
  const max = Math.max(1, ...grid.flat());

  const stepFor = (v: number) => {
    if (v <= 0) return 'rgb(var(--text)/0.05)';
    // Sequential: one hue, light → dark, magnitude only.
    const idx = Math.min(SEQ.length - 1, Math.floor((v / max) * SEQ.length));
    return SEQ[idx];
  };

  return (
    <div className="relative">
      <div className="flex gap-1.5">
        <div className="flex shrink-0 flex-col justify-between py-px text-[10px] text-ink-3">
          {DAY_NAMES.map((d, i) => (
            <span key={d} className="h-[15px] leading-[15px]">
              {dayName(i)}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="grid gap-[3px]" style={{ gridTemplateColumns: 'repeat(24, minmax(0,1fr))' }}>
            {grid.map((row, d) =>
              row.map((v, h) => (
                <div
                  key={`${d}-${h}`}
                  onMouseEnter={() => setHover({ d, h })}
                  onMouseLeave={() => setHover(null)}
                  className="aspect-square rounded-[2.5px] transition-transform hover:scale-125"
                  style={{ background: stepFor(v) }}
                  title={`${dayName(d)} ${String(h).padStart(2, '0')}:00 — ${v} ${callsWord}`}
                />
              )),
            )}
          </div>
          <div className="mt-1.5 flex justify-between text-[10px] text-ink-3">
            {[0, 6, 12, 18, 23].map((h) => (
              <span key={h}>{String(h).padStart(2, '0')}</span>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 text-[11px] text-ink-3">
        <span>{t('chart.fewer', 'Fewer')}</span>
        <div className="flex gap-[3px]">
          <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: 'rgb(var(--text)/0.05)' }} />
          {SEQ.map((c) => (
            <span key={c} className="h-2.5 w-2.5 rounded-[2px]" style={{ background: c }} />
          ))}
        </div>
        <span>{t('chart.more', 'More')}</span>
        {hover && (
          <span className="ml-auto text-ink-2">
            {dayName(hover.d)} {String(hover.h).padStart(2, '0')}:00 ·{' '}
            <span className="font-medium text-ink tabular">{grid[hover.d][hover.h]}</span> {callsWord}
          </span>
        )}
      </div>
    </div>
  );
}

/* ═══ donut ════════════════════════════════════════════════════ */

export function Donut({
  segments,
  centerLabel,
  centerValue,
}: {
  segments: Array<{ label: string; value: number }>;
  centerLabel?: string;
  centerValue?: string;
}) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  const [hover, setHover] = useState<number | null>(null);
  const R = 54;
  const stroke = 18;
  const C = 2 * Math.PI * R;

  const arcs = useMemo(() => {
    let offset = 0;
    return segments.map((s, i) => {
      const frac = s.value / total;
      // 2px visual gap between adjacent arcs.
      const len = Math.max(0, frac * C - 2);
      const arc = { ...s, i, dash: `${len} ${C - len}`, offset: -offset * C, frac };
      offset += frac;
      return arc;
    });
  }, [segments, total, C]);

  return (
    <div className="flex flex-wrap items-center gap-6">
      <svg viewBox="0 0 140 140" className="h-[140px] w-[140px] shrink-0" role="img" aria-label="Share by language">
        <circle cx="70" cy="70" r={R} fill="none" stroke="rgb(var(--text)/0.07)" strokeWidth={stroke} />
        {arcs.map((a) => (
          <circle
            key={a.label}
            cx="70"
            cy="70"
            r={R}
            fill="none"
            stroke={SERIES[a.i % SERIES.length]}
            strokeWidth={hover === a.i ? stroke + 3 : stroke}
            strokeDasharray={a.dash}
            strokeDashoffset={a.offset}
            transform="rotate(-90 70 70)"
            strokeLinecap="butt"
            className="transition-[stroke-width] duration-150"
            onMouseEnter={() => setHover(a.i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
        {centerValue && (
          <>
            <text x="70" y="68" textAnchor="middle" className="fill-[rgb(var(--text))] text-[20px] font-semibold">
              {centerValue}
            </text>
            <text x="70" y="84" textAnchor="middle" className="fill-[rgb(var(--text-3))] text-[10px]">
              {centerLabel}
            </text>
          </>
        )}
      </svg>

      <div className="min-w-0 flex-1 space-y-2">
        {segments.map((s, i) => (
          <div
            key={s.label}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            className={cn(
              'flex items-center justify-between gap-3 rounded-[7px] px-2 py-1 transition-colors',
              hover === i && 'bg-surface-3',
            )}
          >
            <span className="inline-flex min-w-0 items-center gap-2 text-[13px] text-ink">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                style={{ background: SERIES[i % SERIES.length] }}
              />
              <span className="truncate">{s.label}</span>
            </span>
            <span className="shrink-0 text-[12.5px] text-ink-2 tabular">
              {fmtInt(s.value)} · {((s.value / total) * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══ latency distribution ═════════════════════════════════════ */

export function LatencyBars({
  buckets,
  target = 1000,
  locale,
}: {
  buckets: Array<{ label: string; ms: number }>;
  target?: number;
  locale?: UiLocale;
}) {
  const t = translator(locale ?? 'en');
  const max = Math.max(target * 1.1, ...buckets.map((b) => b.ms));
  return (
    <div className="space-y-3">
      {buckets.map((b) => {
        const over = b.ms > target;
        return (
          <div key={b.label}>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-[12.5px] text-ink-2">{b.label}</span>
              <span
                className={cn(
                  'text-[13px] font-semibold tabular',
                  over ? 'text-danger' : 'text-ink',
                )}
              >
                {b.ms ? `${Math.round(b.ms)} ms` : '—'}
              </span>
            </div>
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-[rgb(var(--text)/0.07)]">
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{
                  width: `${Math.min(100, (b.ms / max) * 100)}%`,
                  background: over ? 'rgb(var(--danger))' : 'var(--series-1)',
                }}
              />
              <div
                className="absolute inset-y-0 w-px bg-[rgb(var(--text)/0.35)]"
                style={{ left: `${(target / max) * 100}%` }}
                title={`Target ${target} ms`}
              />
            </div>
          </div>
        );
      })}
      <p className="text-[11.5px] text-ink-3">
        {t(
          'chart.latencyTarget',
          'The hairline marks the {ms} ms target — past it a caller starts to feel the pause.',
        ).replace('{ms}', String(target))}
      </p>
    </div>
  );
}

/* ═══ helpers ══════════════════════════════════════════════════ */

function niceCeil(v: number) {
  if (v <= 5) return 5;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / mag) * mag;
}

function shortDay(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.getDate()}/${d.getMonth() + 1}`;
}

function longDay(iso: string, locale?: UiLocale) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : new Intl.DateTimeFormat(localeTag(locale), {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      }).format(d);
}

export const SERIES_COLORS = SERIES;
