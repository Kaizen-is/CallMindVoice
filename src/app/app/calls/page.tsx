import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { coreGet } from '@/lib/core';
import type { Call } from '@/lib/types';
import { CallList } from './list';

export const metadata: Metadata = { title: 'Call history' };
export const dynamic = 'force-dynamic';

export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { user } = await requireSession();
  const params = await searchParams;

  // The filtered, paged history comes from the Python backend (backend/app/operations.py), which
  // reads the search params as this page did (outcome, lang, q, page; a repeated key is an array).
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params as Record<string, string | string[] | undefined>)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, v);
  }
  const { calls, paging } = await coreGet<{
    calls: Call[];
    paging: { page: number; pages: number; total: number; pageSize: number };
  }>(`/views/calls?${query.toString()}`);

  return (
    <CallList
      calls={calls}
      locale={user.locale}
      filters={{ outcome: params.outcome ?? 'all', lang: params.lang ?? 'all', q: params.q ?? '' }}
      paging={paging}
    />
  );
}
