import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { translator } from '@/lib/i18n';
import { all } from '@/lib/db';
import { AI_MINUTE_UZS, UZS_RATES } from '@/lib/catalog';
import type { WalletLedger } from '@/lib/types';
import { fmtDateTime, fmtUzs } from '@/lib/utils';
import { Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { TopUp } from './top-up';
import { IconAlert, IconArrowUpRight, IconClock, IconCreditCard, IconMinus, IconWave } from '@/components/icons';

export const metadata: Metadata = { title: 'Billing' };
export const dynamic = 'force-dynamic';

/** Below this the balance card warns the owner to top up (so'm). */
const LOW_BALANCE_UZS = 100_000;

export default async function BillingPage() {
  const { tenant, user } = await requireSession();
  const t = translator(user.locale);

  const balance = tenant.balance_uzs;
  const negative = balance < 0;
  const low = !negative && balance < LOW_BALANCE_UZS;
  const isOwner = user.role === 'owner';

  const ledger = all<WalletLedger>(
    'SELECT * FROM wallet_ledger WHERE tenant_id=? ORDER BY created_at DESC LIMIT 15',
    tenant.id,
  );

  const rates: Array<{ label: string; amount: number }> = [
    { label: t('billing.rate.realTalk', 'Live conversation'), amount: UZS_RATES.realTalkPerMin },
    { label: t('billing.rate.tts', 'Speech synthesis'), amount: UZS_RATES.ttsPerMin },
    { label: t('billing.rate.stt', 'Speech recognition'), amount: UZS_RATES.sttPerMin },
  ];

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader
        title={t('nav.billing', 'Billing')}
        subtitle={t('billing.balanceSubtitle', 'Your prepaid balance. Calls draw from it as they happen.')}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-[15px] font-semibold text-ink">{t('billing.balance', 'Balance')}</h3>
              <p className="mt-0.5 text-[12.5px] text-ink-3">{t('billing.currentBalance', 'Current balance')}</p>
            </div>
            <span className="flex h-10 w-10 items-center justify-center rounded-[11px] bg-brand-soft text-brand">
              <IconCreditCard size={20} />
            </span>
          </div>

          <div
            className={`mt-4 text-[38px] leading-none font-semibold tabular ${
              negative ? 'text-danger' : low ? 'text-warning' : 'text-ink'
            }`}
          >
            {fmtUzs(balance)}
          </div>

          <p className="mt-3 text-[12.5px] text-ink-3">
            {t('billing.aiRateNote', 'Each AI-handled minute draws {amount} from your balance.').replace(
              '{amount}',
              fmtUzs(AI_MINUTE_UZS),
            )}
          </p>

          {(low || negative) && (
            <div
              className={`mt-4 flex items-start gap-2.5 rounded-[11px] p-3 ${
                negative ? 'bg-danger-soft' : 'bg-warning-soft'
              }`}
            >
              <span className={`mt-px shrink-0 ${negative ? 'text-danger' : 'text-warning'}`}>
                <IconAlert size={16} />
              </span>
              <p className={`text-[12.5px] leading-relaxed ${negative ? 'text-danger' : 'text-warning'}`}>
                {negative
                  ? t('billing.negativeBalance', 'Your balance is below zero. Top up to keep calls flowing.')
                  : t('billing.lowBalance', 'Balance running low — top up to keep your agent answering.')}
              </p>
            </div>
          )}
        </Card>

        <Card>
          <h3 className="text-[15px] font-semibold text-ink">{t('billing.addFunds', 'Add funds')}</h3>
          <div className="mt-4">
            {isOwner ? (
              <TopUp locale={user.locale} />
            ) : (
              <p className="text-[12.5px] leading-relaxed text-ink-3">
                {t('billing.topUpOwnerOnly', 'Only the account owner can top up the balance.')}
              </p>
            )}
          </div>
        </Card>
      </div>

      <Card className="mt-4">
        <h3 className="text-[15px] font-semibold text-ink">{t('billing.rates', 'Per-minute rates')}</h3>
        <p className="mt-0.5 text-[12.5px] text-ink-3">
          {t('billing.ratesNote', 'What a minute of each draws from your balance.')}
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {rates.map((r) => (
            <div key={r.label} className="rounded-[11px] bg-surface-2 p-3.5">
              <div className="flex items-center gap-2 text-[12px] text-ink-3">
                <IconWave size={14} />
                {r.label}
              </div>
              <div className="mt-1.5 text-[18px] leading-none font-semibold text-ink tabular">{fmtUzs(r.amount)}</div>
              <div className="mt-1 text-[11.5px] text-ink-3">{t('billing.perMinute', 'per minute')}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="mt-4" padded={false}>
        <div className="flex items-center gap-2 px-5 py-4 hairline-b">
          <IconClock size={16} className="text-ink-3" />
          <h3 className="text-[14px] font-semibold text-ink">{t('billing.activity', 'Recent activity')}</h3>
        </div>
        {ledger.length === 0 ? (
          <EmptyState
            icon={<IconCreditCard size={22} />}
            title={t('billing.activityEmpty', 'No activity yet')}
            description={t('billing.activityEmptyHint', 'Top-ups and call charges will show up here.')}
          />
        ) : (
          <div className="divide-y divide-[rgb(var(--line)/var(--line-alpha))]">
            {ledger.map((row) => {
              const isTopup = row.kind === 'topup';
              return (
                <div key={row.id} className="flex items-center gap-3 px-5 py-3">
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                      isTopup ? 'bg-success-soft text-success' : 'bg-surface-3 text-ink-3'
                    }`}
                  >
                    {isTopup ? <IconArrowUpRight size={14} /> : <IconMinus size={14} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-ink">
                      {isTopup
                        ? t('billing.ledger.topup', 'Top-up')
                        : t('billing.ledger.debit', 'Call charge')}
                    </div>
                    <div className="text-[12px] text-ink-3">{fmtDateTime(row.created_at, user.locale)}</div>
                  </div>
                  <span
                    className={`text-[13.5px] font-medium tabular ${isTopup ? 'text-success' : 'text-ink-3'}`}
                  >
                    {isTopup ? '+' : '−'}
                    {fmtUzs(row.amount_uzs)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
