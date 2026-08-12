'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { addNumberAction, removeNumberAction } from '@/app/actions/ops';
import type { PhoneNumber, UiLocale } from '@/lib/types';
import { translator } from '@/lib/i18n';
import { fmtInt, fmtMoney } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, EmptyState, IconButton, PageHeader } from '@/components/ui/primitives';
import { Field, Input, Select } from '@/components/ui/forms';
import { ConfirmDialog, Modal, useToast } from '@/components/ui/overlays';
import { CopyField } from '@/components/console/copy-field';
import {
  IconAlert,
  IconCheckCircle,
  IconGlobe,
  IconPhone,
  IconPlus,
  IconTrash,
} from '@/components/icons';

type Row = PhoneNumber & { agent_name: string | null; call_count: number };

export function NumbersManager({
  numbers,
  telephony,
  canEdit,
  twilioWebhookUrl,
  locale,
}: {
  numbers: Row[];
  telephony: {
    configured: boolean;
    mode: 'asterisk' | 'twilio' | 'simulator';
    accountSid: string | null;
  };
  canEdit: boolean;
  twilioWebhookUrl: string;
  locale: UiLocale;
}) {
  const t = translator(locale);
  const router = useRouter();
  const toast = useToast();
  const [, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<Row | null>(null);
  const [form, setForm] = useState({ e164: '', label: '', provider: 'simulator' });
  const [busy, setBusy] = useState(false);

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title={t('nav.numbers', 'Phone numbers')}
        subtitle={t(
          'numbers.subtitle',
          'The lines your agent answers. Connect Asterisk / FreePBX, Twilio, or use the simulator while you test.',
        )}
        actions={
          canEdit ? (
            <Button variant="primary" icon={<IconPlus size={15} />} onClick={() => setAdding(true)}>
              {t('numbers.connect', 'Connect a number')}
            </Button>
          ) : undefined
        }
      />

      <Card className={telephony.configured ? 'mb-4 bg-success-soft' : 'mb-4 bg-surface-2'}>
        <div className="flex items-start gap-3">
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${
              telephony.configured ? 'bg-success text-white' : 'bg-surface-3 text-ink-3'
            }`}
          >
            {telephony.configured ? <IconCheckCircle size={17} /> : <IconAlert size={17} />}
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[13.5px] font-semibold text-ink">
              {telephony.mode === 'asterisk'
                ? t('numbers.asteriskConnected', 'Asterisk / FreePBX bridge configured')
                : telephony.mode === 'twilio'
                  ? t('numbers.twilioConnected', 'Twilio connected ({sid})').replace(
                      '{sid}',
                      telephony.accountSid ?? '',
                    )
                  : t('numbers.simulatorTitle', 'Running on the built-in simulator')}
            </h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
              {telephony.mode === 'asterisk'
                ? t(
                    'numbers.asteriskDesc',
                    'The authenticated AudioSocket bridge can send live Asterisk calls through this agent.',
                  )
                : telephony.mode === 'twilio'
                  ? t(
                      'numbers.twilioDesc',
                      'Point your Twilio number at the webhook below and real calls will flow through the same engine.',
                    )
                  : t(
                      'numbers.simulatorDesc',
                      'Configure the Asterisk / FreePBX bridge or Twilio to take real calls. Until then, simulated traffic exercises the identical pipeline.',
                    )}
            </p>
            {telephony.mode === 'asterisk' ? (
              <div className="mt-3">
                <CopyField
                  label={t('numbers.bridgeEndpointLabel', 'Bridge turn endpoint (HTTP POST)')}
                  value="/api/telephony/bridge/turn"
                />
              </div>
            ) : telephony.mode === 'twilio' ? (
              <div className="mt-3">
                <CopyField
                  label={t('numbers.webhookLabel', 'Voice webhook (HTTP POST)')}
                  value={twilioWebhookUrl}
                />
              </div>
            ) : null}
          </div>
        </div>
      </Card>

      <Card padded={false}>
        {numbers.length ? (
          <div className="divide-y divide-[rgb(var(--line)/var(--line-alpha))]">
            {numbers.map((n) => (
              <div key={n.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] bg-surface-3 text-ink-2">
                  <IconPhone size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[14px] font-medium text-ink">{n.e164}</span>
                    <Badge tone={n.provider === 'twilio' ? 'success' : 'neutral'}>{t(`provider.${n.provider}`, n.provider)}</Badge>
                    <Badge tone="neutral">{n.region}</Badge>
                  </div>
                  <p className="mt-0.5 text-[12.5px] text-ink-3">
                    {n.label} ·{' '}
                    {t('numbers.routedTo', 'routed to {n}').replace(
                      '{n}',
                      n.agent_name ?? t('numbers.noAgent', 'no agent'),
                    )}{' '}
                    · {t('numbers.callsCount', '{n} calls').replace('{n}', fmtInt(n.call_count))} ·{' '}
                    {fmtMoney(n.monthly_cost, 'USD', 2)}
                    {t('numbers.perMonth', '/mo')}
                  </p>
                </div>
                {canEdit && (
                  <IconButton label={t('numbers.releaseNumber', 'Release number')} size="sm" onClick={() => setConfirm(n)}>
                    <IconTrash size={16} />
                  </IconButton>
                )}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<IconGlobe size={20} />}
            title={t('numbers.emptyTitle', 'No numbers connected')}
            description={t('numbers.emptyHint', 'Add one to start taking calls.')}
          />
        )}
      </Card>

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title={t('numbers.connect', 'Connect a number')}
        description={t(
          'numbers.modalDesc',
          'The number must already exist in Asterisk / FreePBX, with your carrier, or in Twilio — this points it at your agent.',
        )}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                const res = await addNumberAction(form);
                setBusy(false);
                if (res.ok) {
                  toast.success(t('numbers.toastConnectedTitle', 'Connected'), res.message);
                  setAdding(false);
                  setForm({ e164: '', label: '', provider: 'simulator' });
                  start(() => router.refresh());
                } else toast.error(t('numbers.toastConnectFailed', 'Could not connect'), res.message);
              }}
            >
              {t('numbers.connectShort', 'Connect')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field
            label={t('numbers.fieldNumber', 'Number')}
            hint={t('numbers.fieldNumberHint', 'International format, for example +998712000000.')}
          >
            <Input
              value={form.e164}
              onChange={(e) => setForm({ ...form, e164: e.target.value })}
              placeholder="+998712000000"
            />
          </Field>
          <Field label={t('numbers.fieldLabel', 'Label')}>
            <Input
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              placeholder={t('numbers.labelPlaceholder', 'Reception line')}
            />
          </Field>
          <Field label={t('numbers.fieldCarrier', 'Carrier')}>
            <Select
              value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value })}
            >
              <option value="simulator">{t('numbers.optSimulator', 'Simulator (no real calls)')}</option>
              <option value="sip">{t('numbers.optAsterisk', 'Asterisk / FreePBX or carrier SIP')}</option>
              <option value="twilio">Twilio</option>
            </Select>
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(confirm)}
        onClose={() => setConfirm(null)}
        danger
        confirmLabel={t('numbers.release', 'Release')}
        title={t('numbers.releaseConfirmTitle', 'Release {n}?').replace('{n}', confirm?.e164 ?? '')}
        description={t(
          'numbers.releaseConfirmDesc',
          'Calls to this number stop reaching your agent immediately. Call history is kept.',
        )}
        onConfirm={async () => {
          if (!confirm) return;
          const res = await removeNumberAction(confirm.id);
          if (res.ok) toast.success(t('numbers.toastReleasedTitle', 'Released'), res.message);
          start(() => router.refresh());
        }}
      />
    </div>
  );
}
