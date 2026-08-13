import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { all } from '@/lib/db';
import type { Call } from '@/lib/types';
import { CallList } from './list';

export const metadata: Metadata = { title: 'Call history' };
export const dynamic = 'force-dynamic';

export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { tenant, user } = await requireSession();
  const params = await searchParams;

  // Default to real calls only — playground/test sessions are channel='web' and
  // should not clutter the history that operators and analysts review.
  const filters: string[] = ['tenant_id = ?', "channel != 'web'"];
  const args: unknown[] = [tenant.id];

  if (params.outcome && params.outcome !== 'all') {
    if (params.outcome === 'escalated') filters.push('escalated = 1');
    else filters.push('outcome = ?'), args.push(params.outcome);
  }
  if (params.lang && params.lang !== 'all') {
    filters.push('language = ?');
    args.push(params.lang);
  }
  if (params.q) {
    filters.push('(from_e164 LIKE ? OR caller_name LIKE ? OR summary LIKE ? OR intent LIKE ?)');
    const like = `%${params.q}%`;
    args.push(like, like, like, like);
  }

  const calls = all<Call>(
    `SELECT * FROM calls WHERE ${filters.join(' AND ')} ORDER BY started_at DESC LIMIT 200`,
    ...args,
  );

  return (
    <CallList
      calls={calls}
      locale={user.locale}
      filters={{ outcome: params.outcome ?? 'all', lang: params.lang ?? 'all', q: params.q ?? '' }}
    />
  );
}
