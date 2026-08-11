'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { translator } from '@/lib/i18n';
import { CALL_STATUS_LABEL, OUTCOME_LABEL } from '@/lib/catalog';
import type { Call, UiLocale } from '@/lib/types';
import { cn, fmtDateTime, fmtLatency, maskPhone } from '@/lib/utils';
import { Badge, Card, EmptyState, PageHeader, Segmented } from '@/components/ui/primitives';
import { Input, Select } from '@/components/ui/forms';
import { IconCheckCircle, IconHeadset, IconPhone, IconSearch, IconX } from '@/components/icons';

export function CallList({
  calls,
  locale,
  filters,
}: {
  calls: Call[];
  locale: UiLocale;
  filters: { outcome: string; lang: string; q: string };
}) {
  const router = useRouter();
  const params = useSearchParams();
  const t = translator(locale);
  const [q, setQ] = useState(filters.q);

  const apply = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (!v || v === 'all') next.delete(k);
      else next.set(k, v);
    }
    router.push(`/app/calls?${next.toString()}`);
  };

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title={t('nav.calls')}
        subtitle={t(
          'calls.subtitle',
          'Every call, with the transcript and the passages behind each answer.',
        )}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            apply({ q });
          }}
          className="min-w-[220px] flex-1"
        >
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('calls.searchPlaceholder', 'Search number, caller, intent or summary…')}
            icon={<IconSearch size={15} />}
            suffix={q ? undefined : undefined}
          />
        </form>
        <Segmented
          value={filters.outcome}
          onChange={(v) => apply({ outcome: v })}
          options={[
            { value: 'all', label: t('common.all', 'All') },
            { value: 'resolved_by_ai', label: t('calls.filter.ai', 'AI') },
            { value: 'escalated', label: t('calls.filter.escalated', 'Escalated') },
            { value: 'abandoned', label: t('calls.filter.abandoned', 'Abandoned') },
          ]}
        />
        <Select
          value={filters.lang}
          onChange={(e) => apply({ lang: e.target.value })}
          className="w-auto min-w-[120px]"
        >
          <option value="all">{t('calls.allLanguages', 'All languages')}</option>
          <option value="uz">{t('calls.lang.uz', 'Uzbek')}</option>
          <option value="ru">{t('calls.lang.ru', 'Russian')}</option>
          <option value="en">{t('calls.lang.en', 'English')}</option>
        </Select>
        {(filters.q || filters.outcome !== 'all' || filters.lang !== 'all') && (
          <button
            onClick={() => {
              setQ('');
              router.push('/app/calls');
            }}
            className="inline-flex items-center gap-1 rounded-[9px] px-2.5 py-2 text-[12.5px] text-ink-3 transition-colors hover:text-ink"
          >
            <IconX size={14} />
            {t('calls.clear', 'Clear')}
          </button>
        )}
      </div>

      <Card padded={false} className="overflow-hidden">
        {calls.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px]">
              <thead>
                <tr className="text-left text-[11.5px] font-medium tracking-wide text-ink-3 uppercase hairline-b">
                  <th className="px-5 py-3">{t('calls.col.caller', 'Caller')}</th>
                  <th className="px-3 py-3">{t('calls.col.outcome', 'Outcome')}</th>
                  <th className="px-3 py-3">{t('calls.col.intent', 'Intent')}</th>
                  <th className="px-3 py-3">{t('calls.col.lang', 'Lang')}</th>
                  <th className="px-3 py-3 text-right">{t('calls.col.turns', 'Turns')}</th>
                  <th className="px-3 py-3 text-right">{t('calls.col.length', 'Length')}</th>
                  <th className="px-3 py-3 text-right">{t('calls.col.latency', 'Latency')}</th>
                  <th className="px-3 py-3 text-right">{t('calls.col.csat', 'CSAT')}</th>
                  <th className="px-5 py-3 text-right">{t('calls.col.when', 'When')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[rgb(var(--line)/var(--line-alpha))]">
                {calls.map((c) => (
                  <tr key={c.id} className="group transition-colors hover:bg-surface-2">
                    <td className="px-5 py-3">
                      <Link href={`/app/calls/${c.id}`} className="flex items-center gap-2.5">
                        <span
                          className={cn(
                            'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
                            c.escalated
                              ? 'bg-warning-soft text-warning'
                              : c.outcome === 'abandoned'
                                ? 'bg-danger-soft text-danger'
                                : 'bg-success-soft text-success',
                          )}
                        >
                          {c.escalated ? <IconHeadset size={13} /> : <IconCheckCircle size={13} />}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-medium text-ink">
                            {c.caller_name ?? maskPhone(c.from_e164)}
                          </span>
                          <span className="block truncate text-[11.5px] text-ink-3">{c.from_e164}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="px-3 py-3">
                      <Badge
                        tone={
                          c.outcome === 'resolved_by_ai'
                            ? 'success'
                            : c.outcome === 'abandoned'
                              ? 'danger'
                              : c.escalated
                                ? 'warning'
                                : 'neutral'
                        }
                      >
                        {c.outcome
                          ? t(`outcome.${c.outcome}`, OUTCOME_LABEL[c.outcome] ?? c.outcome)
                          : t(`status.${c.status}`, CALL_STATUS_LABEL[c.status] ?? c.status)}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 text-[12.5px] text-ink-2">{c.intent ? t(`intent.${c.intent}`, c.intent) : '—'}</td>
                    <td className="px-3 py-3 text-[12.5px] text-ink-2">{c.language.toUpperCase()}</td>
                    <td className="px-3 py-3 text-right text-[12.5px] text-ink-2 tabular">{c.turns}</td>
                    <td className="px-3 py-3 text-right text-[12.5px] text-ink-2 tabular">
                      {c.duration_ms ? `${Math.round(c.duration_ms / 1000)}s` : '—'}
                    </td>
                    <td className="px-3 py-3 text-right text-[12.5px] tabular">
                      <span
                        className={cn(
                          (c.avg_latency_ms ?? 0) > 1000 ? 'text-danger' : 'text-ink-2',
                        )}
                      >
                        {fmtLatency(c.avg_latency_ms)}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right text-[12.5px] text-ink-2 tabular">
                      {c.csat ? `${c.csat}/5` : '—'}
                    </td>
                    <td className="px-5 py-3 text-right text-[12px] whitespace-nowrap text-ink-3">
                      {fmtDateTime(c.started_at, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={<IconPhone size={20} />}
            title={t('calls.emptyTitle', 'No calls match')}
            description={t(
              'calls.emptyHint',
              'Adjust the filters, or run a simulated call to populate the history.',
            )}
          />
        )}
      </Card>

      {calls.length >= 200 && (
        <p className="mt-3 text-center text-[12px] text-ink-3">
          {t(
            'calls.limitNote',
            'Showing the 200 most recent calls. Narrow the filters to see older ones.',
          )}
        </p>
      )}
    </div>
  );
}
