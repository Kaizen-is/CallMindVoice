'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { addNumberAction, removeNumberAction } from '@/app/actions/ops';
import type { PhoneNumber } from '@/lib/types';
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
  webhookUrl,
}: {
  numbers: Row[];
  telephony: { configured: boolean; mode: string; accountSid: string | null };
  canEdit: boolean;
  webhookUrl: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<Row | null>(null);
  const [form, setForm] = useState({ e164: '', label: '', provider: 'simulator' });
  const [busy, setBusy] = useState(false);

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader
        title="Phone numbers"
        subtitle="The lines your agent answers. Connect a Twilio number, a carrier SIP trunk, or run on the simulator while you test."
        actions={
          canEdit ? (
            <Button variant="primary" icon={<IconPlus size={15} />} onClick={() => setAdding(true)}>
              Connect a number
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
              {telephony.configured
                ? `Twilio connected (${telephony.accountSid})`
                : 'Running on the built-in simulator'}
            </h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
              {telephony.configured
                ? 'Point your Twilio number at the webhook below and real calls will flow through the same engine.'
                : 'Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to take real calls. Until then, simulated traffic exercises the identical pipeline — retrieval, generation and escalation are all real.'}
            </p>
            <div className="mt-3">
              <CopyField label="Voice webhook (HTTP POST)" value={webhookUrl} />
            </div>
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
                    <Badge tone={n.provider === 'twilio' ? 'success' : 'neutral'}>{n.provider}</Badge>
                    <Badge tone="neutral">{n.region}</Badge>
                  </div>
                  <p className="mt-0.5 text-[12.5px] text-ink-3">
                    {n.label} · routed to {n.agent_name ?? 'no agent'} · {fmtInt(n.call_count)} calls ·{' '}
                    {fmtMoney(n.monthly_cost, 'USD', 2)}/mo
                  </p>
                </div>
                {canEdit && (
                  <IconButton label="Release number" size="sm" onClick={() => setConfirm(n)}>
                    <IconTrash size={16} />
                  </IconButton>
                )}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<IconGlobe size={20} />}
            title="No numbers connected"
            description="Add one to start taking calls."
          />
        )}
      </Card>

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Connect a number"
        description="The number must already exist with your carrier or Twilio — this points it at your agent."
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
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
                  toast.success('Connected', res.message);
                  setAdding(false);
                  setForm({ e164: '', label: '', provider: 'simulator' });
                  start(() => router.refresh());
                } else toast.error('Could not connect', res.message);
              }}
            >
              Connect
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Number" hint="International format, for example +998712000000.">
            <Input
              value={form.e164}
              onChange={(e) => setForm({ ...form, e164: e.target.value })}
              placeholder="+998712000000"
            />
          </Field>
          <Field label="Label">
            <Input
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              placeholder="Reception line"
            />
          </Field>
          <Field label="Carrier">
            <Select
              value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value })}
            >
              <option value="simulator">Simulator (no real calls)</option>
              <option value="twilio">Twilio</option>
              <option value="sip">Carrier SIP trunk</option>
            </Select>
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(confirm)}
        onClose={() => setConfirm(null)}
        danger
        confirmLabel="Release"
        title={`Release ${confirm?.e164 ?? ''}?`}
        description="Calls to this number stop reaching your agent immediately. Call history is kept."
        onConfirm={async () => {
          if (!confirm) return;
          const res = await removeNumberAction(confirm.id);
          if (res.ok) toast.success('Released', res.message);
          start(() => router.refresh());
        }}
      />
    </div>
  );
}
