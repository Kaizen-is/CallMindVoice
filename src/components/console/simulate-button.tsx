'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  clearHistoryAction,
  seedDemoHistoryAction,
  simulateBurstAction,
  simulateCallAction,
  stopSimulationAction,
} from '@/app/actions/ops';
import { Button } from '@/components/ui/primitives';
import { Menu, useToast } from '@/components/ui/overlays';
import { IconChart, IconChevronDown, IconPhoneIn, IconStop, IconTrash } from '@/components/icons';
import { translator } from '@/lib/i18n';
import type { UiLocale } from '@/lib/types';

/**
 * Starts simulated traffic. The simulator drives the same engine as the phone
 * lines, so what appears on the wallboard is real retrieval and real answers.
 */
export function SimulateButton({
  compact = false,
  locale = 'uz',
}: {
  compact?: boolean;
  locale?: UiLocale;
}) {
  const t = translator(locale);
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (res.ok) toast.success(t('sim.toastTitle', 'Simulator'), res.message ?? t('sim.started', 'Started.'));
    else toast.error(t('sim.couldNotStart', 'Could not start'), res.message ?? '');
    start(() => router.refresh());
  };

  return (
    <div className="inline-flex">
      <Button
        variant="primary"
        size={compact ? 'sm' : 'md'}
        loading={busy || pending}
        icon={<IconPhoneIn size={15} />}
        className="rounded-r-none"
        onClick={() => void run(() => simulateCallAction())}
      >
        {compact ? t('sim.simulate', 'Simulate') : t('sim.simulateCall', 'Simulate a call')}
      </Button>
      <Menu
        width={216}
        trigger={({ toggle }) => (
          <Button
            variant="primary"
            size={compact ? 'sm' : 'md'}
            onClick={toggle}
            aria-label={t('sim.moreOptions', 'More simulator options')}
            className="rounded-l-none border-l border-white/20 px-2"
          >
            <IconChevronDown size={14} />
          </Button>
        )}
        items={[
          { label: t('sim.uzbekCaller', 'Uzbek caller'), onClick: () => void run(() => simulateCallAction({ language: 'uz' })) },
          { label: t('sim.russianCaller', 'Russian caller'), onClick: () => void run(() => simulateCallAction({ language: 'ru' })) },
          { label: t('sim.englishCaller', 'English caller'), onClick: () => void run(() => simulateCallAction({ language: 'en' })) },
          { type: 'separator' },
          { label: t('sim.hardQuestion', 'Hard question (escalates)'), onClick: () => void run(() => simulateCallAction({ difficulty: 1 })) },
          { label: t('sim.burst8', 'Burst of 8 calls'), onClick: () => void run(() => simulateBurstAction(8)) },
          { label: t('sim.burst20', 'Burst of 20 calls'), onClick: () => void run(() => simulateBurstAction(20)) },
          { type: 'separator' },
          {
            label: t('sim.backfill', 'Backfill 30 days (demo)'),
            icon: <IconChart size={14} />,
            onClick: () =>
              void run(async () => {
                const res = await seedDemoHistoryAction();
                return { ok: res.ok, message: res.message };
              }),
          },
          {
            label: t('sim.stopAll', 'Stop all simulated calls'),
            icon: <IconStop size={14} />,
            onClick: () => void run(() => stopSimulationAction()),
          },
          {
            label: t('sim.eraseHistory', 'Erase all call history'),
            danger: true,
            icon: <IconTrash size={14} />,
            onClick: () => void run(() => clearHistoryAction()),
          },
        ]}
      />
    </div>
  );
}
