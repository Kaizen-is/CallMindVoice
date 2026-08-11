'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { changePlanAction } from '@/app/actions/ops';
import { PLANS } from '@/lib/catalog';
import { translator } from '@/lib/i18n';
import type { UiLocale } from '@/lib/types';
import { fmtInt, fmtMoney } from '@/lib/utils';
import { Button } from '@/components/ui/primitives';
import { ConfirmDialog, useToast } from '@/components/ui/overlays';
import { IconCheck } from '@/components/icons';

export function PlanPicker({
  current,
  canChange,
  locale,
}: {
  current: string;
  canChange: boolean;
  locale: UiLocale;
}) {
  const router = useRouter();
  const toast = useToast();
  const t = translator(locale);
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
                <h3 className="text-[14px] font-semibold text-ink">{t(`plan.${p.id}.name`, p.name)}</h3>
                {active && <IconCheck size={16} className="text-brand" />}
              </div>
              <div className="mt-2 text-[24px] leading-none font-semibold text-ink tabular">
                {p.priceUsd
                  ? fmtMoney(p.priceUsd, 'USD', 0)
                  : p.id === 'payg'
                    ? `${fmtMoney(p.overagePerMinute, 'USD', 3)}/min`
                    : t('billing.free', 'Free')}
              </div>
              <p className="mt-2 min-h-[34px] text-[12.5px] leading-relaxed text-ink-3">{t(`plan.${p.id}.blurb`, p.blurb)}</p>
              <ul className="mt-3 flex-1 space-y-1.5 text-[12.5px] text-ink-2">
                <li>
                  {p.minutesIncluded
                    ? t('billing.minPerMonth', '{n} min / month').replace('{n}', fmtInt(p.minutesIncluded))
                    : t('billing.billedPerMinute', 'Billed per minute')}
                </li>
                <li>
                  {(p.numbers === 1
                    ? t('billing.phoneNumberOne', '{n} phone number')
                    : t('billing.phoneNumberMany', '{n} phone numbers')
                  ).replace('{n}', String(p.numbers))}
                </li>
                <li>
                  {p.seats > 100
                    ? t('billing.seatsUnlimited', 'Unlimited seats')
                    : t('billing.seatsCount', '{n} seats').replace('{n}', String(p.seats))}
                </li>
              </ul>
              {canChange && !active && p.id !== 'trial' && (
                <Button
                  size="sm"
                  variant="secondary"
                  full
                  className="mt-4"
                  onClick={() => setTarget(p.id)}
                >
                  {t('billing.switchTo', 'Switch to {name}').replace('{name}', t(`plan.${p.id}.name`, p.name))}
                </Button>
              )}
              {active && (
                <div className="mt-4 rounded-[8px] bg-brand-soft py-1.5 text-center text-[12px] font-medium text-brand-ink">
                  {t('billing.currentPlan', 'Current plan')}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={Boolean(target)}
        onClose={() => setTarget(null)}
        confirmLabel={t('billing.switchPlan', 'Switch plan')}
        title={t('billing.switchToTitle', 'Switch to {name}?').replace(
          '{name}',
          target ? t(`plan.${target}.name`, PLANS.find((p) => p.id === target)?.name ?? '') : '',
        )}
        description={t(
          'billing.switchDesc',
          'The change applies from the next billing period. Nothing is interrupted.',
        )}
        onConfirm={async () => {
          if (!target) return;
          const res = await changePlanAction(target);
          if (res.ok) toast.success(t('billing.planChanged', 'Plan changed'), res.message);
          start(() => router.refresh());
        }}
      />
    </>
  );
}
