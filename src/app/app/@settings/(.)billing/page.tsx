import { BillingView } from '@/app/app/billing/billing-view';
import { SettingsModalSignal } from '@/components/console/settings-modal';

export const dynamic = 'force-dynamic';

// Intercepted (modal) view of /app/billing — renders the exact same UZS balance
// content as the full page so the two can never drift (it used to show a stale
// USD plan view while the full page had moved to the so'm balance model).
export default function BillingModal() {
  return (
    <>
      <SettingsModalSignal />
      <BillingView />
    </>
  );
}
