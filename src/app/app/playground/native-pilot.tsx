'use client';

import type { Translate } from '@/lib/i18n';
import { cn, fmtLatency } from '@/lib/utils';
import { Badge, Button, Card } from '@/components/ui/primitives';
import { IconMic, IconStop } from '@/components/icons';
import { useNativeCall } from '@/hooks/use-native-call';

/**
 * L8 pilot (?native=1): the same agent, answered natively by Gemini Live — it hears, decides when the
 * caller has finished, and speaks in one model. The loan facts stay in our code (tools); the text
 * guardrail's flags show under any agent line that said a sum it was not given.
 */
export function NativePilot({ agentId, lang, t }: { agentId: string; lang: string; t: Translate }) {
  const call = useNativeCall({ agentId, lang });
  const busy = call.state === 'connecting' || call.state === 'live';
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[14px] font-semibold text-ink">{t('play.native.title', 'Native audio pilot')}</h3>
        <Badge tone="info">{call.model || 'Gemini Live'}</Badge>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
        {t(
          'play.native.note',
          'One model hears, decides when you have finished and speaks. Identity, the balance and the promise are checked by our code.',
        )}
      </p>
      <div className="mt-3 flex items-center gap-2">
        {busy ? (
          <Button variant="danger" icon={<IconStop size={15} />} onClick={call.hangUp}>
            {t('play.native.hangUp', 'Hang up')}
          </Button>
        ) : (
          <Button variant="primary" icon={<IconMic size={15} />} onClick={() => void call.start()} disabled={!agentId}>
            {t('play.native.call', 'Call with native audio')}
          </Button>
        )}
        {call.state === 'connecting' && <span className="text-[12px] text-ink-3">…</span>}
        {call.error && <span className="text-[12px] text-danger">{call.error}</span>}
      </div>
      {(call.lines.length > 0 || call.live.caller || call.live.agent) && (
        <div className="mt-3 space-y-1.5 text-[13px]">
          {call.lines.map((line, i) => (
            <div key={i} className={cn(line.role === 'caller' ? 'text-ink-2' : 'text-ink')}>
              <span className="mr-1.5 text-[11px] text-ink-3">{line.role === 'caller' ? '🗣' : '🤖'}</span>
              {line.text}
              {line.role === 'agent' && line.firstMs != null && (
                <span className="ml-1.5 text-[11px] text-ink-3 tabular">{fmtLatency(line.firstMs)}</span>
              )}
              {line.flags?.map((f) => (
                <Badge key={f} tone="danger" className="ml-1.5">
                  {f}
                </Badge>
              ))}
            </div>
          ))}
          {call.live.caller && <div className="text-ink-3">🗣 {call.live.caller}</div>}
          {call.live.agent && <div className="text-ink-3">🤖 {call.live.agent}</div>}
        </div>
      )}
      {(call.tools.length > 0 || call.promise) && (
        <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
          {call.tools.map((tool, i) => (
            <span key={i} className="rounded-full bg-surface-2 px-2 py-0.5 text-ink-3">
              {tool.name} → {JSON.stringify(tool.result)}
            </span>
          ))}
          {call.promise && (
            <span className="rounded-full bg-success-soft px-2 py-0.5 text-success">
              {t('play.promise', 'Promise to pay')}: {String(call.promise.date)}
              {call.promise.amountText ? ` · ${String(call.promise.amountText)}` : ''}
            </span>
          )}
        </div>
      )}
    </Card>
  );
}
