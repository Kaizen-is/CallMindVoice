'use client';

import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import Link from 'next/link';
import { cn, initials } from '@/lib/utils';

/* ═══ Button ═══════════════════════════════════════════════════ */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'outline';
type Size = 'xs' | 'sm' | 'md' | 'lg';

const VARIANT: Record<Variant, string> = {
  primary:
    'bg-brand text-white shadow-[0_1px_2px_rgb(0_0_0/0.12),inset_0_1px_0_rgb(255_255_255/0.14)] hover:bg-brand-hover active:brightness-95',
  secondary:
    'bg-surface-3 text-ink hairline hover:bg-surface-2 active:brightness-97 dark:bg-surface-2 dark:hover:bg-surface-3',
  outline: 'bg-transparent text-ink hairline hover:bg-surface-3',
  ghost: 'bg-transparent text-ink-2 hover:bg-surface-3 hover:text-ink',
  danger: 'bg-danger text-white hover:brightness-108 active:brightness-95',
  success: 'bg-success text-white hover:brightness-108 active:brightness-95',
};

const SIZE: Record<Size, string> = {
  xs: 'h-7 px-2.5 text-[12.5px] gap-1.5 rounded-[7px]',
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-[8px]',
  md: 'h-9.5 px-4 text-[13.5px] gap-2 rounded-[10px]',
  lg: 'h-11 px-5 text-[15px] gap-2 rounded-[11px]',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  iconRight?: ReactNode;
  loading?: boolean;
  full?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  loading,
  full,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex select-none items-center justify-center font-medium transition-[background,color,box-shadow,transform] duration-150 active:scale-[0.985] disabled:pointer-events-none disabled:opacity-45',
        VARIANT[variant],
        SIZE[size],
        full && 'w-full',
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Spinner size={size === 'lg' ? 16 : 14} /> : icon}
      {children}
      {iconRight}
    </button>
  );
}

export function LinkButton({
  href,
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  full,
  className,
  children,
  ...rest
}: {
  href: string;
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  iconRight?: ReactNode;
  full?: boolean;
  className?: string;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLAnchorElement>, 'color'>) {
  return (
    <Link
      href={href}
      className={cn(
        'inline-flex select-none items-center justify-center font-medium transition-all duration-150 active:scale-[0.985]',
        VARIANT[variant],
        SIZE[size],
        full && 'w-full',
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
      {iconRight}
    </Link>
  );
}

export function IconButton({
  label,
  size = 'md',
  variant = 'ghost',
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: Size; variant?: Variant }) {
  const dim = { xs: 'h-7 w-7', sm: 'h-8 w-8', md: 'h-9 w-9', lg: 'h-10 w-10' }[size];
  return (
    <button
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[9px] transition-all duration-150 active:scale-95 disabled:opacity-40',
        VARIANT[variant],
        dim,
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ═══ Spinner ══════════════════════════════════════════════════ */

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cn('animate-spin-slow shrink-0', className)}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2.6" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ═══ Card ═════════════════════════════════════════════════════ */

export function Card({
  className,
  children,
  padded = true,
  hover,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { padded?: boolean; hover?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-[14px] bg-surface hairline shadow-e1',
        padded && 'p-5',
        hover && 'transition-all duration-200 hover:shadow-e2 hover:-translate-y-px',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  icon,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-surface-3 text-ink-2">
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold text-ink">{title}</h3>
          {subtitle && <p className="mt-0.5 text-[13px] leading-relaxed text-ink-3">{subtitle}</p>}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/* ═══ Badge / Chip ═════════════════════════════════════════════ */

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'violet';

const TONE: Record<Tone, string> = {
  neutral: 'bg-surface-3 text-ink-2',
  brand: 'bg-brand-soft text-brand-ink',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
  violet: 'bg-brand-soft text-violet',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
  dot,
  icon,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  dot?: boolean;
  icon?: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11.5px] font-medium whitespace-nowrap',
        TONE[tone],
        className,
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {icon}
      {children}
    </span>
  );
}

export function StatusDot({ tone = 'neutral', pulse }: { tone?: Tone; pulse?: boolean }) {
  const color = {
    neutral: 'bg-ink-3',
    brand: 'bg-brand',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
    info: 'bg-info',
    violet: 'bg-violet',
  }[tone];
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      {pulse && <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', color)} />}
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', color)} />
    </span>
  );
}

/* ═══ Avatar ═══════════════════════════════════════════════════ */

export function Avatar({
  name,
  hue = 210,
  size = 32,
  presence,
  className,
}: {
  name: string;
  hue?: number;
  size?: number;
  presence?: 'online' | 'away' | 'offline';
  className?: string;
}) {
  return (
    <span className={cn('relative inline-flex shrink-0', className)} style={{ width: size, height: size }}>
      <span
        className="flex h-full w-full items-center justify-center rounded-full font-semibold text-white select-none"
        style={{
          fontSize: size * 0.38,
          background: `linear-gradient(140deg, hsl(${hue} 72% 58%), hsl(${(hue + 42) % 360} 70% 47%))`,
        }}
      >
        {initials(name)}
      </span>
      {presence && (
        <span
          className={cn(
            'absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-[rgb(var(--surface))]',
            presence === 'online' ? 'bg-success' : presence === 'away' ? 'bg-warning' : 'bg-ink-3',
          )}
          style={{ width: size * 0.29, height: size * 0.29 }}
        />
      )}
    </span>
  );
}

/* ═══ Layout helpers ═══════════════════════════════════════════ */

export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumb,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 pb-6">
      <div className="min-w-0">
        {breadcrumb && <div className="mb-2 text-[12.5px] text-ink-3">{breadcrumb}</div>}
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.028em] text-ink">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Divider({ className, label }: { className?: string; label?: string }) {
  if (label) {
    return (
      <div className={cn('flex items-center gap-3', className)}>
        <span className="h-px flex-1 bg-[rgb(var(--line)/var(--line-alpha))]" />
        <span className="text-[11.5px] font-medium tracking-wide text-ink-3 uppercase">{label}</span>
        <span className="h-px flex-1 bg-[rgb(var(--line)/var(--line-alpha))]" />
      </div>
    );
  }
  return <div className={cn('h-px w-full bg-[rgb(var(--line)/var(--line-alpha))]', className)} />;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-[14px] bg-surface-3 text-ink-3">
          {icon}
        </div>
      )}
      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-[13.5px] leading-relaxed text-ink-3">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-[8px]', className)} />;
}

/* ═══ Progress ═════════════════════════════════════════════════ */

export function Progress({
  value,
  tone = 'brand',
  className,
  height = 6,
}: {
  value: number;
  tone?: Tone;
  className?: string;
  height?: number;
}) {
  const bar = {
    neutral: 'bg-ink-3',
    brand: 'bg-brand',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
    info: 'bg-info',
    violet: 'bg-violet',
  }[tone];
  return (
    <div
      className={cn('w-full overflow-hidden rounded-full bg-[rgb(var(--text)/0.09)]', className)}
      style={{ height }}
      role="progressbar"
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-500 ease-out', bar)}
        style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
      />
    </div>
  );
}

/* ═══ Tooltip (CSS only) ═══════════════════════════════════════ */

export function Tooltip({
  content,
  children,
  side = 'top',
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}) {
  const pos = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  }[side];
  return (
    <span className={cn('group/tt relative inline-flex', className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-50 hidden w-max max-w-[240px] rounded-[8px] bg-[rgb(var(--text))] px-2.5 py-1.5 text-[12px] leading-snug font-medium text-[rgb(var(--text-inverse))] opacity-0 shadow-e3 transition-opacity duration-150 group-hover/tt:block group-hover/tt:opacity-100',
          pos,
        )}
      >
        {content}
      </span>
    </span>
  );
}

/* ═══ Segmented control ════════════════════════════════════════ */

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: ReactNode; icon?: ReactNode }>;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-0.5 rounded-[10px] bg-surface-3 p-0.5',
        className,
      )}
      role="tablist"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-[8px] font-medium whitespace-nowrap transition-all duration-150',
              size === 'sm' ? 'h-7 px-2.5 text-[12.5px]' : 'h-8 px-3 text-[13px]',
              active
                ? 'bg-surface text-ink shadow-e1'
                : 'text-ink-3 hover:text-ink-2',
            )}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ═══ Tabs ═════════════════════════════════════════════════════ */

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: Array<{ value: T; label: string; count?: number; icon?: ReactNode }>;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-1 overflow-x-auto no-scrollbar hairline-b', className)} role="tablist">
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.value)}
            className={cn(
              'relative inline-flex items-center gap-2 px-3 pb-2.5 text-[13.5px] font-medium whitespace-nowrap transition-colors',
              active ? 'text-ink' : 'text-ink-3 hover:text-ink-2',
            )}
          >
            {t.icon}
            {t.label}
            {t.count !== undefined && (
              <span
                className={cn(
                  'rounded-full px-1.5 py-px text-[11px] tabular',
                  active ? 'bg-brand-soft text-brand-ink' : 'bg-surface-3 text-ink-3',
                )}
              >
                {t.count}
              </span>
            )}
            {active && (
              <span className="absolute inset-x-1 -bottom-px h-[2px] rounded-full bg-brand" />
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ═══ Key-value ════════════════════════════════════════════════ */

export function KeyValue({
  items,
  className,
  columns = 1,
}: {
  items: Array<{ label: string; value: ReactNode }>;
  className?: string;
  columns?: 1 | 2;
}) {
  return (
    <dl className={cn('grid gap-x-6 gap-y-3', columns === 2 && 'sm:grid-cols-2', className)}>
      {items.map((it) => (
        <div key={it.label} className="flex items-baseline justify-between gap-4">
          <dt className="text-[12.5px] whitespace-nowrap text-ink-3">{it.label}</dt>
          <dd className="min-w-0 truncate text-right text-[13px] font-medium text-ink">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
