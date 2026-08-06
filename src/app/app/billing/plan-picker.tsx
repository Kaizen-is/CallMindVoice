'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { changePlanAction } from '@/app/actions/ops';
import { PLANS } from '@/lib/catalog';
import { fmtInt, fmtMoney } from '@/lib/utils';
import { Button } from '@/components/ui/primitives';
import { ConfirmDialog, useToast } from '@/components/ui/overlays';
import { IconCheck } from '@/components/icons';

export function PlanPicker({ current, canChange }: { current: string; canChange: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [, start] = useTransition();
  const [target, setTarget] = useState<string | null>(null);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {PLANS.filter((p) => p.id !== 'trial' || current === 'trial').map((p) => {
          const active = p.id === current;
          return (
            <div
              key={p.id}
              className={`flex flex-col rounded-[14px] p-5 shadow-e1 ${
                active ? 'bg-surface ring-2 ring-[rgb(var(--brand))]' : 'bg-surface hairline'
              }`}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-[14px] font-semibold text-ink">{p.name}</h3>
                {active && <IconCheck size={16} className="text-brand" />}
              </div>
              <div className="mt-2 text-[24px] leading-none font-semibold text-ink tabular">
                {p.priceUsd ? fmtMoney(p.priceUsd, 'USD', 0) : 'Free'}
              </div>
              <p className="mt-2 min-h-[34px] text-[12.5px] leading-relaxed text-ink-3">{p.blurb}</p>
              <ul className="mt-3 flex-1 space-y-1.5 text-[12.5px] text-ink-2">
                <li>{fmtInt(p.callsIncluded)} calls / month</li>
                <li>{p.numbers} phone number{p.numbers === 1 ? '' : 's'}</li>
                <li>{p.seats > 100 ? 'Unlimited' : p.seats} seats</li>
              </ul>
              {canChange && !active && p.id !== 'trial' && (
                <Button
                  size="sm"
                  variant="secondary"
                  full
                  className="mt-4"
                  onClick={() => setTarget(p.id)}
                >
                  Switch to {p.name}
                </Button>
              )}
              {active && (
                <div className="mt-4 rounded-[8px] bg-brand-soft py-1.5 text-center text-[12px] font-medium text-brand-ink">
                  Current plan
                </div>
              )}
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={Boolean(target)}
        onClose={() => setTarget(null)}
        confirmLabel="Switch plan"
        title={`Switch to ${PLANS.find((p) => p.id === target)?.name ?? ''}?`}
        description="The change applies from the next billing period. Nothing is interrupted."
        onConfirm={async () => {
          if (!target) return;
          const res = await changePlanAction(target);
          if (res.ok) toast.success('Plan changed', res.message);
          start(() => router.refresh());
        }}
      />
    </>
  );
}
