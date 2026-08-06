'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { addFaqAction } from '@/app/actions/knowledge';
import { ignoreGapAction, resolveGapAction } from '@/app/actions/ops';
import { Badge, Button, EmptyState } from '@/components/ui/primitives';
import { Textarea } from '@/components/ui/forms';
import { useToast } from '@/components/ui/overlays';
import { IconCheckCircle, IconPlus, IconX } from '@/components/icons';
import { relativeTime } from '@/lib/utils';

interface Gap {
  id: string;
  question: string;
  hits: number;
  best_score: number;
  last_seen: string;
}

/**
 * Turns "the agent could not answer this" into a one-click fix: writing an
 * answer here indexes it as an FAQ entry, so the next caller gets a real reply.
 */
export function GapList({ gaps }: { gaps: Gap[] }) {
  const router = useRouter();
  const toast = useToast();
  const [openId, setOpenId] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [, start] = useTransition();

  if (!gaps.length) {
    return (
      <EmptyState
        icon={<IconCheckCircle size={20} />}
        title="No gaps right now"
        description="Every question callers asked was answerable from your knowledge base."
      />
    );
  }

  const submit = async (gap: Gap) => {
    if (answer.trim().length < 8) {
      toast.error('Write an answer first', 'A sentence or two is enough.');
      return;
    }
    setBusy(true);
    const res = await addFaqAction('Answers added from call gaps', [
      { q: gap.question, a: answer.trim() },
    ]);
    if (res.ok) await resolveGapAction(gap.id, answer.trim());
    setBusy(false);
    setOpenId(null);
    setAnswer('');
    if (res.ok) toast.success('Indexed', 'Your agent can answer that now.');
    else toast.error('Could not index that', res.message);
    start(() => router.refresh());
  };

  return (
    <div className="divide-y divide-[rgb(var(--line)/var(--line-alpha))]">
      {gaps.map((g) => (
        <div key={g.id} className="px-5 py-3.5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] text-ink">“{g.question}”</p>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-3">
                <Badge tone={g.hits > 2 ? 'warning' : 'neutral'}>
                  asked {g.hits}×
                </Badge>
                <span>best match {(g.best_score * 100).toFixed(0)}%</span>
                <span>· {relativeTime(g.last_seen)}</span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                size="xs"
                variant="secondary"
                icon={<IconPlus size={13} />}
                onClick={() => {
                  setOpenId(openId === g.id ? null : g.id);
                  setAnswer('');
                }}
              >
                Answer it
              </Button>
              <Button
                size="xs"
                variant="ghost"
                aria-label="Dismiss"
                onClick={() => {
                  void ignoreGapAction(g.id).then(() => start(() => router.refresh()));
                }}
              >
                <IconX size={14} />
              </Button>
            </div>
          </div>

          {openId === g.id && (
            <div className="animate-fade-up mt-3 space-y-2">
              <Textarea
                autoFocus
                rows={3}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="Write the answer exactly as you would say it on the phone…"
              />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setOpenId(null)}>
                  Cancel
                </Button>
                <Button size="sm" variant="primary" loading={busy} onClick={() => void submit(g)}>
                  Add to knowledge base
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
