/**
 * Class-name joiner. Accepts anything so `cond && 'cls'` works even when
 * `cond` is a ReactNode or a number, and keeps only real strings.
 */
export function cn(...parts: unknown[]) {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');
}

export function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

export function fmtInt(n: number) {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

export function fmtMoney(n: number, currency = 'USD', digits = 2) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

export function fmtPct(n: number, digits = 0) {
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

export function fmtDuration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtLatency(ms: number | null | undefined) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function relativeTime(iso: string | null | undefined, nowMs = Date.now()) {
  if (!iso) return '—';
  const diff = nowMs - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const sign = diff >= 0 ? -1 : 1;
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536e6],
    ['month', 2592e6],
    ['week', 6048e5],
    ['day', 864e5],
    ['hour', 36e5],
    ['minute', 6e4],
    ['second', 1000],
  ];
  for (const [unit, msPer] of units) {
    if (abs >= msPer || unit === 'second') {
      return rtf.format(sign * Math.round(abs / msPer), unit);
    }
  }
  return 'just now';
}

export function fmtDate(iso: string | null | undefined, opts?: Intl.DateTimeFormatOptions) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...opts,
  }).format(new Date(iso));
}

export function fmtTime(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

export function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return '—';
  return `${fmtDate(iso)} · ${fmtTime(iso)}`;
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

export function slugify(s: string) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Deterministic pseudo-random in [0,1) from a string seed — stable demo data. */
export function seededRandom(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  const idx = clamp(Math.ceil((p / 100) * sorted.length) - 1, 0, sorted.length - 1);
  return sorted[idx];
}

export function maskPhone(e164: string) {
  if (e164.length < 7) return e164;
  return `${e164.slice(0, -6)}••${e164.slice(-4)}`;
}

export function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function truncate(s: string, n: number) {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

export function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function dayKeysBack(n: number, from = new Date()): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(from.getTime() - i * 864e5).toISOString().slice(0, 10));
  }
  return out;
}
