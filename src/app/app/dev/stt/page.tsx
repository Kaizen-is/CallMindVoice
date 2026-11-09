import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { listSpeechTests } from '@/lib/engine/calls';
import { ENGINES } from '@/lib/speech/registry';
import { sttEngineIds } from '@/lib/speech/stt';
import { SttLab } from './stt-lab';

export const metadata: Metadata = { title: 'Speech to Text' };
export const dynamic = 'force-dynamic';

export default async function DevSttPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { tenant, user } = await requireSession();
  const history = listSpeechTests(tenant.id, 'stt');
  const params = await searchParams;
  const ready = sttEngineIds() as Record<string, boolean>;
  const models = ENGINES.filter((e) => e.kind === 'stt').map((e) => ({
    id: e.id,
    name: e.name,
    detail: e.via ? `${e.vendor} · ${e.via}` : e.vendor,
    ready: Boolean(ready[e.id]),
    setup: e.setup,
  }));
  // ?model=… from Models ▸ Model lab ▸ Test; otherwise the first model set up here.
  const initialModel =
    models.find((m) => m.id === params.model && m.ready)?.id ?? models.find((m) => m.ready)?.id ?? '';

  return <SttLab locale={user.locale} history={history} models={models} initialModel={initialModel} />;
}
