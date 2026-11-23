'use client';

/**
 * The tester's brief for a goal-led agent (Python backend, `?py=1`).
 *
 * An agent with a goal is the one calling, and it needs answers from the
 * person — so the tester has to know who they are playing. This card asks the
 * Python API for a scenario (`GET /api/core/playground/scenario`): the person's
 * name and year of birth (for the identity check), a situation to act out, a
 * few questions to try, and what the agent will ask for. After the call,
 * "What did the agent collect?" shows the answers the agent took down
 * (`POST /api/core/playground/collect`). Agents without a goal show nothing.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Translate } from '@/lib/i18n';
import { Badge, Button, Card } from '@/components/ui/primitives';

interface Scenario {
  you: string;
  birthYear: string;
  purpose: string;
  situation: string;
  questions: string[];
  agentNeeds: string[];
}

interface Collected {
  result: {
    fields: Record<string, string | null>;
    identityConfirmed: boolean | null;
    outcome: string;
    complete: boolean;
  };
  labels: Record<string, string>;
}

function pythonBackend(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('py') === '1';
}

export function ScenarioCard({ agentId, callId, t }: { agentId: string; callId: string | null; t: Translate }) {
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [collected, setCollected] = useState<Collected | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    // Only the Python backend knows goals; checked here (after mount) so the server render stays the same.
    if (!agentId || !pythonBackend()) return setScenario(null);
    try {
      const res = await fetch(`/api/core/playground/scenario?agentId=${encodeURIComponent(agentId)}`);
      const body = res.ok ? ((await res.json()) as { scenario: Scenario | null }) : { scenario: null };
      setScenario(body.scenario);
    } catch {
      setScenario(null);
    }
    setCollected(null);
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => setCollected(null), [callId]);

  if (!scenario) return null;

  const check = async () => {
    if (!callId) return;
    setLoading(true);
    try {
      const res = await fetch('/api/core/playground/collect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callId }),
      });
      if (res.ok) setCollected((await res.json()) as Collected);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="mb-4 border-brand/30">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex items-center gap-2">
            <Badge tone="brand">{t('play.scenario.badge', 'Your role')}</Badge>
            <span className="text-[13px] font-semibold text-ink">
              {scenario.you}
              {scenario.birthYear ? ` · ${t('play.scenario.born', 'born')} ${scenario.birthYear}` : ''}
            </span>
          </div>
          <p className="text-[12.5px] text-ink-3">
            {t('play.scenario.intro', 'The agent calls you. Answer as this person; say "Allo" to pick up.')}
          </p>
          {scenario.situation && <p className="text-[13px] text-ink">{scenario.situation}</p>}
          {scenario.questions.length > 0 && (
            <p className="text-[12.5px] text-ink-2">
              <span className="text-ink-3">{t('play.scenario.try', 'Try asking:')} </span>
              {scenario.questions.map((q) => `“${q}”`).join(' · ')}
            </p>
          )}
          <p className="text-[12.5px] text-ink-3">
            {t('play.scenario.needs', 'The agent will ask for:')} {scenario.agentNeeds.join(', ')}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            {t('play.scenario.another', 'Another role')}
          </Button>
          <Button size="sm" variant="secondary" disabled={!callId} loading={loading} onClick={() => void check()}>
            {t('play.scenario.collect', 'What did the agent collect?')}
          </Button>
        </div>
      </div>
      {collected && (
        <div className="mt-3 border-t pt-3">
          <dl className="grid gap-x-4 gap-y-1 text-[12.5px] sm:grid-cols-2">
            {Object.entries(collected.result.fields).map(([key, value]) => (
              <div key={key} className="flex gap-2">
                <dt className="text-ink-3">{collected.labels[key] ?? key}:</dt>
                <dd className={value ? 'text-ink' : 'text-ink-3'}>{value ?? '—'}</dd>
              </div>
            ))}
          </dl>
          {collected.result.outcome && <p className="mt-2 text-[12.5px] text-ink-2">{collected.result.outcome}</p>}
          <div className="mt-2">
            <Badge tone={collected.result.complete ? 'success' : 'warning'}>
              {collected.result.complete
                ? t('play.scenario.complete', 'Everything collected')
                : t('play.scenario.incomplete', 'Some answers missing')}
            </Badge>
          </div>
        </div>
      )}
    </Card>
  );
}
