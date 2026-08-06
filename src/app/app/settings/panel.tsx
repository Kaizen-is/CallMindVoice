'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { updateTenantAction } from '@/app/actions/ops';
import { setLocaleAction } from '@/app/actions/auth';
import { INDUSTRIES, ROLE_LABEL } from '@/lib/catalog';
import { LOCALE_LABEL, LOCALES } from '@/lib/i18n';
import type { UiLocale } from '@/lib/types';
import { fmtBytes, fmtDate, fmtInt } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, KeyValue, PageHeader, Segmented } from '@/components/ui/primitives';
import { Field, Input, Select } from '@/components/ui/forms';
import { useToast } from '@/components/ui/overlays';
import { CopyField } from '@/components/console/copy-field';
import { IconDatabase, IconGlobe, IconLock, IconShield, IconSparkle } from '@/components/icons';

const TIMEZONES = [
  'Asia/Tashkent',
  'Asia/Samarkand',
  'Asia/Almaty',
  'Europe/Moscow',
  'Europe/London',
  'UTC',
];

export function SettingsPanel({
  tenant,
  user,
  canEdit,
  engines,
  stats,
}: {
  tenant: {
    id: string;
    name: string;
    slug: string;
    industry: string;
    country: string;
    timezone: string;
    plan: string;
    createdAt: string;
  };
  user: { name: string; email: string; role: string; locale: UiLocale };
  canEdit: boolean;
  engines: {
    generation: string;
    generationHosted: boolean;
    embedding: string;
    embeddingHosted: boolean;
    telephony: string;
    telephonyHosted: boolean;
  };
  stats: { documents: number; chunks: number; tokens: number; bytes: number };
}) {
  const router = useRouter();
  const toast = useToast();
  const [, start] = useTransition();
  const [form, setForm] = useState({
    name: tenant.name,
    industry: tenant.industry,
    timezone: tenant.timezone,
    country: tenant.country,
  });
  const [busy, setBusy] = useState(false);

  const dirty =
    form.name !== tenant.name ||
    form.industry !== tenant.industry ||
    form.timezone !== tenant.timezone ||
    form.country !== tenant.country;

  return (
    <div className="mx-auto max-w-[900px]">
      <PageHeader title="Settings" subtitle="Company details, language, and what is running under the hood." />

      <div className="space-y-4">
        <Card>
          <CardHeader title="Company" subtitle="Used in greetings, invoices and the operator console." />
          <fieldset disabled={!canEdit} className="mt-5 grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Industry">
              <Select
                value={form.industry}
                onChange={(e) => setForm({ ...form, industry: e.target.value })}
              >
                {INDUSTRIES.map((i) => (
                  <option key={i.value} value={i.value}>
                    {i.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Country">
              <Select
                value={form.country}
                onChange={(e) => setForm({ ...form, country: e.target.value })}
              >
                <option value="UZ">Uzbekistan</option>
                <option value="KZ">Kazakhstan</option>
                <option value="KG">Kyrgyzstan</option>
                <option value="TJ">Tajikistan</option>
                <option value="RU">Russia</option>
                <option value="OTHER">Elsewhere</option>
              </Select>
            </Field>
            <Field label="Timezone" hint="Business hours and reports use this clock.">
              <Select
                value={form.timezone}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </Select>
            </Field>
          </fieldset>
          {canEdit && dirty && (
            <div className="mt-4 flex justify-end">
              <Button
                variant="primary"
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  const res = await updateTenantAction(form);
                  setBusy(false);
                  if (res.ok) toast.success('Saved', res.message);
                  start(() => router.refresh());
                }}
              >
                Save changes
              </Button>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Console language"
            subtitle="Only affects this interface — the agent answers callers in whatever they speak."
          />
          <div className="mt-4">
            <Segmented
              className="max-w-full flex-wrap"
              value={user.locale}
              onChange={(v) => {
                void setLocaleAction(v);
                start(() => router.refresh());
              }}
              options={LOCALES.map((l) => ({ value: l, label: LOCALE_LABEL[l] }))}
            />
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Running engines"
            subtitle="Ovoz works with no third-party keys at all. Add credentials to swap any row for a hosted provider."
            icon={<IconSparkle size={16} />}
          />
          <div className="mt-4 space-y-3">
            <EngineRow
              icon={<IconSparkle size={16} />}
              label="Answer generation"
              value={engines.generation}
              hosted={engines.generationHosted}
              hint="ANTHROPIC_API_KEY"
            />
            <EngineRow
              icon={<IconDatabase size={16} />}
              label="Embeddings"
              value={engines.embedding}
              hosted={engines.embeddingHosted}
              hint="OPENAI_API_KEY"
            />
            <EngineRow
              icon={<IconGlobe size={16} />}
              label="Telephony"
              value={engines.telephony}
              hosted={engines.telephonyHosted}
              hint="TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN"
            />
          </div>
        </Card>

        <Card>
          <CardHeader title="Data" subtitle="What is stored for this tenant right now." icon={<IconDatabase size={16} />} />
          <div className="mt-4">
            <KeyValue
              columns={2}
              items={[
                { label: 'Documents', value: fmtInt(stats.documents) },
                { label: 'Indexed passages', value: fmtInt(stats.chunks) },
                { label: 'Tokens indexed', value: fmtInt(stats.tokens) },
                { label: 'Source size', value: fmtBytes(stats.bytes) },
                { label: 'Plan', value: tenant.plan },
                { label: 'Created', value: fmtDate(tenant.createdAt) },
              ]}
            />
          </div>
          <div className="mt-4 space-y-3">
            <CopyField label="Tenant ID" value={tenant.id} />
          </div>
        </Card>

        <Card>
          <CardHeader title="Security" subtitle="How your data is kept apart from everyone else's." icon={<IconShield size={16} />} />
          <ul className="mt-4 space-y-3">
            {[
              {
                icon: <IconLock size={15} />,
                t: 'Tenant isolation at the data layer',
                d: 'Every query carries your tenant id. There is no code path that reads another company’s documents or calls.',
              },
              {
                icon: <IconShield size={15} />,
                t: 'Passwords are scrypt-hashed',
                d: 'Per-user salt, 16384 rounds. Sessions are HMAC-signed httpOnly cookies with a 30-day expiry.',
              },
              {
                icon: <IconDatabase size={15} />,
                t: 'Documents stay where you put them',
                d: 'With local engines, no document text leaves this deployment — not for embedding, not for generation.',
              },
            ].map((i) => (
              <li key={i.t} className="flex gap-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-surface-3 text-ink-3">
                  {i.icon}
                </span>
                <div>
                  <div className="text-[13px] font-medium text-ink">{i.t}</div>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-3">{i.d}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader title="Your account" />
          <div className="mt-4">
            <KeyValue
              columns={2}
              items={[
                { label: 'Name', value: user.name },
                { label: 'Email', value: user.email },
                { label: 'Role', value: ROLE_LABEL[user.role] ?? user.role },
                { label: 'Console language', value: LOCALE_LABEL[user.locale] },
              ]}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}

function EngineRow({
  icon,
  label,
  value,
  hosted,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hosted: boolean;
  hint: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[11px] bg-surface-2 px-4 py-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-surface-3 text-ink-3">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink">{label}</div>
        <div className="truncate font-mono text-[11.5px] text-ink-3">{value}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge tone={hosted ? 'success' : 'neutral'} dot>
          {hosted ? 'Hosted' : 'Local'}
        </Badge>
        {!hosted && <code className="hidden text-[11px] text-ink-3 sm:inline">{hint}</code>}
      </div>
    </div>
  );
}
