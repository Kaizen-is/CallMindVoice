'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { topUpAction } from '@/app/actions/ops';
import { translator } from '@/lib/i18n';
import type { UiLocale } from '@/lib/types';
import { fmtUzs } from '@/lib/utils';
import { Button } from '@/components/ui/primitives';
import { Field, Input } from '@/components/ui/forms';
import { useToast } from '@/components/ui/overlays';
import { IconPlus } from '@/components/icons';

/** Preset top-up sizes (so'm) — one salary, a few, a bulk deposit. */
const QUICK_AMOUNTS = [500_000, 1_000_000, 5_000_000];

export function TopUp({ locale }: { locale: UiLocale }) {
  const t = translator(locale);
  const router = useRouter();
  const toast = useToast();
  const [, start] = useTransition();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  const value = Math.round(Number(amount));
  const valid = Number.isFinite(value) && value > 0;

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    const res = await topUpAction(value);
    setBusy(false);
    if (res.ok) {
      toast.success(t('billing.topUpSuccess', 'Balance topped up'), fmtUzs(res.balance));
      setAmount('');
      start(() => router.refresh());
    } else {
      toast.error(t('billing.topUpFailed', 'Could not top up'), res.message);
    }
  }

  return (
    <div className="space-y-3">
      <Field label={t('billing.amount', 'Amount')} htmlFor="topup-amount">
        <Input
          id="topup-amount"
          type="number"
          inputMode="numeric"
          min={0}
          step={100_000}
          value={amount}
          placeholder="1 000 000"
          suffix="so‘m"
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </Field>

      <div className="flex flex-wrap gap-2">
        {QUICK_AMOUNTS.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => setAmount(String(q))}
            className="rounded-[8px] bg-surface-3 px-2.5 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
          >
            + {fmtUzs(q)}
          </button>
        ))}
      </div>

      <Button
        variant="primary"
        full
        icon={<IconPlus size={16} />}
        loading={busy}
        disabled={!valid}
        onClick={() => void submit()}
      >
        {t('billing.topUp', 'Top up')}
      </Button>

      <p className="text-[12px] leading-relaxed text-ink-3">
        {t(
          'billing.topUpNote',
          'Manual top-up for now. Real payment (Click, Payme, card) comes in a later step.',
        )}
      </p>
    </div>
  );
}
