'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { updateTenantAction } from '@/app/actions/ops';
import { setLocaleAction } from '@/app/actions/auth';
import { INDUSTRIES, ROLE_LABEL } from '@/lib/catalog';
import { LOCALE_LABEL, LOCALES, translator } from '@/lib/i18n';
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
    telephonyHint: string;
  };
  stats: { documents: number; chunks: number; tokens: number; bytes: number };
}) {
  const t = translator(user.locale);
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
      <PageHeader
        title={t('nav.settings', 'Settings')}
        subtitle={t('settings.subtitle', 'Company details, language, and what is running under the hood.')}
      />

      <div className="space-y-4">
        <Card>
          <CardHeader
            title={t('settings.company.title', 'Company')}
            subtitle={t('settings.company.subtitle', 'Used in greetings, invoices and the operator console.')}
          />
          <fieldset disabled={!canEdit} className="mt-5 grid gap-4 sm:grid-cols-2">
            <Field label={t('settings.company.name', 'Name')}>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label={t('settings.company.industry', 'Industry')}>
              <Select
                value={form.industry}
                onChange={(e) => setForm({ ...form, industry: e.target.value })}
              >
                {INDUSTRIES.map((i) => (
                  <option key={i.value} value={i.value}>
                    {t(`industry.${i.value}`, i.label)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('settings.company.country', 'Country')}>
              <Select
                value={form.country}
                onChange={(e) => setForm({ ...form, country: e.target.value })}
              >
                <option value="UZ">{t('settings.country.uz', 'Uzbekistan')}</option>
                <option value="KZ">{t('settings.country.kz', 'Kazakhstan')}</option>
                <option value="KG">{t('settings.country.kg', 'Kyrgyzstan')}</option>
                <option value="TJ">{t('settings.country.tj', 'Tajikistan')}</option>
                <option value="RU">{t('settings.country.ru', 'Russia')}</option>
                <option value="OTHER">{t('settings.country.other', 'Elsewhere')}</option>
              </Select>
            </Field>
            <Field
              label={t('settings.company.timezone', 'Timezone')}
              hint={t('settings.company.timezoneHint', 'Business hours and reports use this clock.')}
            >
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
                  if (res.ok) toast.success(t('common.saved', 'Saved'), res.message);
                  start(() => router.refresh());
                }}
              >
                {t('settings.saveChanges', 'Save changes')}
              </Button>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            title={t('settings.language.title', 'Console language')}
            subtitle={t('settings.language.subtitle', 'Only affects this interface — the agent answers callers in whatever they speak.')}
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
            title={t('settings.engines.title', 'Running engines')}
            subtitle={t('settings.engines.subtitle', 'Ovoz works with no third-party keys at all. Add credentials to swap any row for a hosted provider.')}
            icon={<IconSparkle size={16} />}
          />
          <div className="mt-4 space-y-3">
            <EngineRow
              t={t}
              icon={<IconSparkle size={16} />}
              label={t('settings.engines.generation', 'Answer generation')}
              value={engines.generation}
              hosted={engines.generationHosted}
              hint="ANTHROPIC_API_KEY"
            />
            <EngineRow
              t={t}
              icon={<IconDatabase size={16} />}
              label={t('settings.engines.embeddings', 'Embeddings')}
              value={engines.embedding}
              hosted={engines.embeddingHosted}
              hint="OPENAI_API_KEY"
            />
            <EngineRow
              t={t}
              icon={<IconGlobe size={16} />}
              label={t('settings.engines.telephony', 'Telephony')}
              value={engines.telephony}
              hosted={engines.telephonyHosted}
              hint={engines.telephonyHint}
            />
          </div>
        </Card>

        <Card>
          <CardHeader
            title={t('settings.data.title', 'Data')}
            subtitle={t('settings.data.subtitle', 'What is stored for this tenant right now.')}
            icon={<IconDatabase size={16} />}
          />
          <div className="mt-4">
            <KeyValue
              columns={2}
              items={[
                { label: t('settings.data.documents', 'Documents'), value: fmtInt(stats.documents) },
                { label: t('settings.data.passages', 'Indexed passages'), value: fmtInt(stats.chunks) },
                { label: t('settings.data.tokens', 'Tokens indexed'), value: fmtInt(stats.tokens) },
                { label: t('settings.data.size', 'Source size'), value: fmtBytes(stats.bytes) },
                { label: t('settings.data.plan', 'Plan'), value: t(`plan.${tenant.plan}.name`, tenant.plan) },
                { label: t('settings.data.created', 'Created'), value: fmtDate(tenant.createdAt, user.locale) },
              ]}
            />
          </div>
          <div className="mt-4 space-y-3">
            <CopyField label={t('settings.data.tenantId', 'Tenant ID')} value={tenant.id} />
          </div>
        </Card>

        <Card>
          <CardHeader
            title={t('settings.security.title', 'Security')}
            subtitle={t('settings.security.subtitle', 'How your data is kept apart from everyone else’s.')}
            icon={<IconShield size={16} />}
          />
          <ul className="mt-4 space-y-3">
            {[
              {
                icon: <IconLock size={15} />,
                t: t('settings.security.isolation.title', 'Tenant isolation at the data layer'),
                d: t('settings.security.isolation.body', 'Every query carries your tenant id. There is no code path that reads another company’s documents or calls.'),
              },
              {
                icon: <IconShield size={15} />,
                t: t('settings.security.passwords.title', 'Passwords are scrypt-hashed'),
                d: t('settings.security.passwords.body', 'Per-user salt, 16384 rounds. Sessions are HMAC-signed httpOnly cookies with a 30-day expiry.'),
              },
              {
                icon: <IconDatabase size={15} />,
                t: t('settings.security.documents.title', 'Documents stay where you put them'),
                d: t('settings.security.documents.body', 'With local engines, no document text leaves this deployment — not for embedding, not for generation.'),
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
          <CardHeader title={t('settings.account.title', 'Your account')} />
          <div className="mt-4">
            <KeyValue
              columns={2}
              items={[
                { label: t('settings.account.name', 'Name'), value: user.name },
                { label: t('settings.account.email', 'Email'), value: user.email },
                { label: t('settings.account.role', 'Role'), value: t(`role.${user.role}`, ROLE_LABEL[user.role] ?? user.role) },
                { label: t('settings.language.title', 'Console language'), value: LOCALE_LABEL[user.locale] },
              ]}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}

function EngineRow({
  t,
  icon,
  label,
  value,
  hosted,
  hint,
}: {
  t: (key: string, fallback?: string) => string;
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
          {hosted ? t('settings.engines.hosted', 'Hosted') : t('settings.engines.local', 'Local')}
        </Badge>
        {!hosted && <code className="hidden text-[11px] text-ink-3 sm:inline">{hint}</code>}
      </div>
    </div>
  );
}
