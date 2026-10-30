import type { Metadata } from 'next';
import { BillingView } from './billing-view';

export const metadata: Metadata = { title: 'Billing' };
export const dynamic = 'force-dynamic';

export default function BillingPage() {
  return <BillingView />;
}
