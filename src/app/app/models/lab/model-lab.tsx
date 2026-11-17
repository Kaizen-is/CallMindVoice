'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { setDefaultLlmAction } from '@/app/actions/models';
import { translator } from '@/lib/i18n';
import type { LlmStat, ModelStats, SttStat, TtsStat, UiLocale } from '@/lib/types';
import { Badge, Button, Card, PageHeader, Tabs } from '@/components/ui/primitives';
import { Select } from '@/components/ui/forms';
import { useToast } from '@/components/ui/overlays';
import { IconArrowUpRight, IconMic, IconSparkle, IconVolume } from '@/components/icons';
import { pct, secs, TableShell, Td, Th, usd } from './shared';

type Tab = 'stt' | 'tts' | 'llm';
type T = ReturnType<typeof translator>;

export function ModelLab({
  locale,
  stats,
  canEdit,
  llmDefault,
  llmInUse,
  llmServerDefaultLabel,
}: {
  locale: UiLocale;
  stats: ModelStats;
  canEdit: boolean;
  /** The account's chosen default model (`provider:model`), or null. */
  llmDefault: string | null;
  /** What answers right now, e.g. "OpenAI gpt-5.5". */
  llmInUse: string;
  /** What answers when no default is chosen. */
  llmServerDefaultLabel: string;
}) {
  const t = translator(locale);
  const [tab, setTab] = useState<Tab>('stt');

  return (
    <div className="w-full">
      <PageHeader title={t('lab.title')} />
      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-5"
        tabs={[
          { value: 'stt', label: t('lab.tab.stt'), icon: <IconMic size={14} /> },
          { value: 'tts', label: t('lab.tab.tts'), icon: <IconVolume size={14} /> },
          { value: 'llm', label: t('lab.tab.llm'), icon: <IconSparkle size={14} /> },
        ]}
      />

      {tab === 'stt' && <SttTab t={t} rows={stats.stt} />}
      {tab === 'tts' && <TtsTab t={t} rows={stats.tts} />}
      {tab === 'llm' && (
        <LlmTab
          t={t}
          rows={stats.llm}
          canEdit={canEdit}
          chosen={llmDefault}
          inUse={llmInUse}
          serverDefaultLabel={llmServerDefaultLabel}
        />
      )}
    </div>
  );
}

/* ── shared bits ─────────────────────────────────────────────── */

function TestLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex h-7 items-center gap-1 rounded-[8px] bg-surface-3 px-2.5 text-[12px] font-medium text-ink hairline hover:bg-surface-2 dark:bg-surface-2 dark:hover:bg-surface-3"
    >
      {label}
      <IconArrowUpRight size={12} />
    </Link>
  );
}

function Status({ t, ready, setup }: { t: T; ready: boolean; setup: string }) {
  return ready ? (
    <Badge tone="success" dot>
      {t('lab.ready')}
    </Badge>
  ) : (
    <Badge tone="neutral">{t('lab.missing').replace('{setup}', setup)}</Badge>
  );
}

function Name({ t, name, vendor, via }: { t: T; name: string; vendor: string; via?: string }) {
  return (
    <>
      <span className="block font-medium text-ink">{name}</span>
      <span className="block text-[11.5px] text-ink-3">
        {vendor}
        {via ? ` · ${t('lab.via').replace('{name}', via)}` : ''}
      </span>
    </>
  );
}

const price = (t: T, own: boolean, n: number | null) => (n == null && own ? t('lab.own') : usd(n));

/** The row with the lowest `value` among ready rows that have one. */
function pick<R extends { ready: boolean }>(rows: R[], value: (r: R) => number | null): R | null {
  let best: R | null = null;
  for (const r of rows) {
    const v = r.ready ? value(r) : null;
    if (v == null) continue;
    if (!best || v < (value(best) as number)) best = r;
  }
  return best;
}

/** A row of small "best at" cards above a table. */
function BestOf({ items }: { items: Array<{ label: string; name: string | null; value: string }> }) {
  return (
    <div className="mb-4 grid gap-3 sm:grid-cols-3">
      {items.map((i) => (
        <Card key={i.label} padded={false} className="px-4 py-3.5">
          <div className="text-[11px] font-medium tracking-wide text-ink-3 uppercase">{i.label}</div>
          <div className="mt-1 truncate text-[14.5px] font-semibold text-ink">{i.name ?? '—'}</div>
          <div className="text-[12px] text-ink-3 tabular">{i.name ? i.value : ''}</div>
        </Card>
      ))}
    </div>
  );
}

const mark = (on: boolean) => (on ? 'font-semibold text-success' : undefined);

/* ── STT ─────────────────────────────────────────────────────── */

function SttTab({ t, rows }: { t: T; rows: SttStat[] }) {
  const accurate = pick(rows, (r) => r.wer);
  const fastest = pick(rows, (r) => r.latencyMs);
  const cheapest = pick(rows, (r) => r.pricePerMin);
  return (
    <>
      <BestOf
        items={[
          { label: t('lab.best.accurate'), name: accurate?.name ?? null, value: `WER ${pct(accurate?.wer)}` },
          { label: t('lab.best.fastest'), name: fastest?.name ?? null, value: secs(fastest?.latencyMs) },
          { label: t('lab.best.cheapest'), name: cheapest?.name ?? null, value: `${usd(cheapest?.pricePerMin)} / min` },
        ]}
      />
      <Card padded={false} className="overflow-hidden">
        <TableShell
          minWidth={780} cols={7}
          head={
            <>
              <Th first>{t('lab.col.engine')}</Th>
              <Th>{t('lab.col.status')}</Th>
              <Th right>{t('lab.col.latency')}</Th>
              <Th right>{t('lab.col.price')}</Th>
              <Th right>{t('lab.col.wer')}</Th>
              <Th right>{t('lab.col.cer')}</Th>
              <Th right>{''}</Th>
            </>
          }
        >
          {rows.map((r) => (
            <tr key={r.id}>
              <Td first>
                <Name t={t} name={r.name} vendor={r.vendor} via={r.via} />
              </Td>
              <Td>
                <Status t={t} ready={r.ready} setup={r.setup} />
              </Td>
              <Td right className={mark(r.id === fastest?.id)}>
                {secs(r.latencyMs)}
              </Td>
              <Td right className={mark(r.id === cheapest?.id)}>
                {price(t, r.own, r.pricePerMin)}
              </Td>
              <Td right className={mark(r.id === accurate?.id)}>
                {pct(r.wer)}
              </Td>
              <Td right>{pct(r.cer)}</Td>
              <Td right>{r.ready && <TestLink href={`/app/dev/stt?model=${r.id}`} label={t('lab.test')} />}</Td>
            </tr>
          ))}
        </TableShell>
      </Card>
    </>
  );
}

/* ── TTS ─────────────────────────────────────────────────────── */

function TtsTab({ t, rows }: { t: T; rows: TtsStat[] }) {
  const clearest = pick(rows, (r) => (r.clarity == null ? null : -r.clarity));
  const fastest = pick(rows, (r) => r.firstMs);
  const cheapest = pick(rows, (r) => r.pricePerMin);
  return (
    <>
      <BestOf
        items={[
          { label: t('lab.best.clearest'), name: clearest?.name ?? null, value: pct(clearest?.clarity, 0) },
          { label: t('lab.best.fastest'), name: fastest?.name ?? null, value: secs(fastest?.firstMs) },
          { label: t('lab.best.cheapest'), name: cheapest?.name ?? null, value: `${usd(cheapest?.pricePerMin)} / min` },
        ]}
      />
      <Card padded={false} className="overflow-hidden">
        <TableShell
          minWidth={780} cols={7}
          head={
            <>
              <Th first>{t('lab.col.engine')}</Th>
              <Th>{t('lab.col.status')}</Th>
              <Th right>{t('lab.col.firstSound')}</Th>
              <Th right>{t('lab.col.latency')}</Th>
              <Th right>{t('lab.col.price')}</Th>
              <Th right>{t('lab.col.clarity')}</Th>
              <Th right>{''}</Th>
            </>
          }
        >
          {rows.map((r) => (
            <tr key={r.id}>
              <Td first>
                <Name t={t} name={r.name} vendor={r.vendor} via={r.via} />
              </Td>
              <Td>
                <Status t={t} ready={r.ready} setup={r.setup} />
              </Td>
              <Td right className={mark(r.id === fastest?.id)}>
                {secs(r.firstMs)}
              </Td>
              <Td right>{secs(r.latencyMs)}</Td>
              <Td right className={mark(r.id === cheapest?.id)}>
                {price(t, r.own, r.pricePerMin)}
              </Td>
              <Td right className={mark(r.id === clearest?.id)}>
                {pct(r.clarity, 0)}
              </Td>
              <Td right>{r.ready && <TestLink href={`/app/models/voices?model=${r.id}`} label={t('lab.test')} />}</Td>
            </tr>
          ))}
        </TableShell>
      </Card>
    </>
  );
}

/* ── LLM ─────────────────────────────────────────────────────── */

function LlmTab({
  t,
  rows,
  canEdit,
  chosen,
  inUse,
  serverDefaultLabel,
}: {
  t: T;
  rows: LlmStat[];
  canEdit: boolean;
  chosen: string | null;
  inUse: string;
  serverDefaultLabel: string;
}) {
  const toast = useToast();
  const router = useRouter();
  const [, start] = useTransition();
  const [value, setValue] = useState(chosen ?? '');
  const [saving, setSaving] = useState(false);
  const fastest = pick(rows, (r) => r.firstMs);
  const cheapest = pick(rows, (r) => r.priceOut);
  const vendors = [...new Set(rows.map((r) => r.vendor))];

  const save = async () => {
    setSaving(true);
    const res = await setDefaultLlmAction(value || null);
    setSaving(false);
    if (res.ok) {
      toast.success(t('common.saved', 'Saved'));
      start(() => router.refresh());
    } else toast.error(t('lab.failTitle'), res.message);
  };

  const tokenPrice = (r: LlmStat) =>
    r.priceIn == null || r.priceOut == null ? price(t, r.own, null) : `${usd(r.priceIn)} / ${usd(r.priceOut)}`;

  return (
    <>
      <Card className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[11px] font-medium tracking-wide text-ink-3 uppercase">{t('lab.llm.defaultTitle')}</div>
            <div className="mt-1 text-[14.5px] font-semibold text-ink">{inUse}</div>
          </div>
          {canEdit && (
            <div className="flex flex-wrap items-center gap-2">
              <Select value={value} onChange={(e) => setValue(e.target.value)} className="w-auto min-w-[260px]">
                <option value="">
                  {t('lab.llm.serverDefault')} — {serverDefaultLabel}
                </option>
                {vendors.map((vendor) => (
                  <optgroup key={vendor} label={vendor}>
                    {rows
                      .filter((r) => r.vendor === vendor)
                      .map((r) => (
                        <option key={r.id} value={r.id} disabled={!r.ready && r.id !== value}>
                          {r.name}
                          {r.ready ? '' : ` — ${t('lab.missing').replace('{setup}', r.setup)}`}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </Select>
              <Button variant="primary" loading={saving} disabled={value === (chosen ?? '')} onClick={() => void save()}>
                {t('common.save', 'Save')}
              </Button>
            </div>
          )}
        </div>
      </Card>

      <BestOf
        items={[
          { label: t('lab.best.fastest'), name: fastest?.name ?? null, value: secs(fastest?.firstMs) },
          { label: t('lab.best.cheapest'), name: cheapest?.name ?? null, value: cheapest ? `${tokenPrice(cheapest)} / 1M` : '' },
          {
            label: t('lab.best.default'),
            name: rows.find((r) => r.id === chosen)?.name ?? inUse,
            value: '',
          },
        ]}
      />

      <Card padded={false} className="overflow-hidden">
        <TableShell
          minWidth={820} cols={6}
          head={
            <>
              <Th first>{t('lab.col.model')}</Th>
              <Th>{t('lab.col.status')}</Th>
              <Th right>{t('lab.col.firstWord')}</Th>
              <Th right>{t('lab.col.latency')}</Th>
              <Th right>{t('lab.col.priceTokens')}</Th>
              <Th right>{''}</Th>
            </>
          }
        >
          {rows.map((r) => (
            <tr key={r.id}>
              <Td first>
                <span className="flex items-center gap-1.5 font-medium text-ink">
                  {r.name}
                  {r.id === chosen && <Badge tone="brand">{t('lab.llm.default')}</Badge>}
                </span>
                <span className="block text-[11.5px] text-ink-3">
                  {r.vendor} · {r.id.slice(r.id.indexOf(':') + 1)}
                </span>
              </Td>
              <Td>
                <Status t={t} ready={r.ready} setup={r.setup} />
              </Td>
              <Td right className={mark(r.id === fastest?.id)}>
                {secs(r.firstMs)}
              </Td>
              <Td right>{secs(r.latencyMs)}</Td>
              <Td right className={mark(r.id === cheapest?.id)}>
                {tokenPrice(r)}
              </Td>
              <Td right>{r.ready && <TestLink href="/app/playground" label={t('lab.test')} />}</Td>
            </tr>
          ))}
        </TableShell>
      </Card>
    </>
  );
}
