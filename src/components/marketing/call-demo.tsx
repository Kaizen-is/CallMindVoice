'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { IconCheckCircle, IconHeadset, IconPhoneIn, IconSparkle } from '@/components/icons';

interface Line {
  role: 'caller' | 'agent' | 'system';
  text: string;
  meta?: string;
  latency?: number;
  cite?: string;
}

const SCRIPTS: Array<{ lang: string; flag: string; lines: Line[] }> = [
  {
    lang: 'Uzbek',
    flag: 'UZ',
    lines: [
      { role: 'system', text: 'Incoming call · +998 90 ••• 41 27' },
      { role: 'caller', text: 'Assalomu alaykum, kardiolog qabuli qancha turadi?' },
      {
        role: 'agent',
        text: 'Kardiolog qabuli 180 000 so‘m. Birinchi konsultatsiya EKG bilan birga.',
        latency: 610,
        cite: 'Narxlar 2026.pdf › Kardiologiya',
      },
      { role: 'caller', text: 'Ertaga bo‘sh joy bormi?' },
      {
        role: 'agent',
        text: 'Ha, ertaga soat 10:30 va 15:00 da joy bor. Qaysi biri qulay?',
        latency: 540,
        cite: 'Jadval › Kardiologiya',
      },
    ],
  },
  {
    lang: 'Russian',
    flag: 'RU',
    lines: [
      { role: 'system', text: 'Входящий звонок · +998 93 ••• 08 55' },
      { role: 'caller', text: 'Здравствуйте, вы принимаете полис страховой компании?' },
      {
        role: 'agent',
        text: 'Да, мы работаем с четырьмя страховыми. Возьмите с собой полис и паспорт.',
        latency: 580,
        cite: 'Регламент приёма.docx › Страхование',
      },
      { role: 'caller', text: 'А по поводу возврата за прошлый приём — с кем поговорить?' },
      {
        role: 'agent',
        text: 'Это лучше решить с администратором — соединяю, одну секунду.',
        latency: 490,
        meta: 'Confidence 0.31 — below threshold',
      },
      { role: 'system', text: 'Transferred to Dilnoza · summary and transcript delivered' },
    ],
  },
  {
    lang: 'English',
    flag: 'EN',
    lines: [
      { role: 'system', text: 'Incoming call · +44 20 ••• 3391' },
      { role: 'caller', text: 'Hi — what time do you close on Saturdays?' },
      {
        role: 'agent',
        text: 'On Saturdays we are open from 10 in the morning until 3 in the afternoon.',
        latency: 470,
        cite: 'Opening hours › Weekend',
      },
      { role: 'caller', text: 'Perfect, thank you.' },
      {
        role: 'agent',
        text: 'You are very welcome. Have a lovely day.',
        latency: 380,
      },
    ],
  },
];

export function CallDemo() {
  const [scriptIndex, setScriptIndex] = useState(0);
  const [visible, setVisible] = useState(0);
  const [typing, setTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const script = SCRIPTS[scriptIndex];

  useEffect(() => {
    if (visible >= script.lines.length) {
      const t = setTimeout(() => {
        setScriptIndex((i) => (i + 1) % SCRIPTS.length);
        setVisible(0);
      }, 3200);
      return () => clearTimeout(t);
    }
    const line = script.lines[visible];
    const isAgent = line.role === 'agent';
    if (isAgent) setTyping(true);
    const delay = isAgent ? 900 : line.role === 'system' ? 700 : 1250;
    const t = setTimeout(() => {
      setTyping(false);
      setVisible((v) => v + 1);
    }, delay);
    return () => clearTimeout(t);
  }, [visible, script]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [visible, typing]);

  return (
    <div className="relative w-full overflow-hidden rounded-[20px] bg-surface shadow-e3 hairline">
      {/* window chrome */}
      <div className="flex items-center justify-between gap-3 bg-surface-2 px-4 py-2.5 hairline-b">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-[#FF5F57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#FEBC2E]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28C840]" />
        </div>
        <div className="flex items-center gap-2 text-[11.5px] font-medium text-ink-3">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-70" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
          </span>
          live · {script.lang}
        </div>
        <div className="w-[52px]" />
      </div>

      <div ref={scrollRef} className="h-[360px] space-y-3 overflow-y-auto p-5 sm:h-[380px]">
        {script.lines.slice(0, visible).map((line, i) => (
          <DemoLine key={`${scriptIndex}-${i}`} line={line} />
        ))}
        {typing && (
          <div className="flex items-end gap-2">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-white">
              <IconSparkle size={14} />
            </div>
            <div className="flex items-center gap-1 rounded-[14px] rounded-bl-[5px] bg-surface-3 px-3.5 py-3">
              {[0, 1, 2].map((d) => (
                <span
                  key={d}
                  className="h-1.5 w-1.5 rounded-full bg-ink-3"
                  style={{
                    animation: 'ovoz-bar 1s ease-in-out infinite',
                    animationDelay: `${d * 0.16}s`,
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 bg-surface-2 px-4 py-2.5 text-[11.5px] text-ink-3 hairline-t">
        <span className="tabular">avg 540 ms to first word</span>
        <span className="flex items-center gap-1.5">
          <IconCheckCircle size={13} className="text-success" />
          grounded in your documents
        </span>
      </div>
    </div>
  );
}

function DemoLine({ line }: { line: Line }) {
  if (line.role === 'system') {
    return (
      <div className="animate-fade flex justify-center py-1">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-3 px-3 py-1 text-[11.5px] font-medium text-ink-3">
          {line.text.toLowerCase().includes('transfer') ? (
            <IconHeadset size={13} className="text-warning" />
          ) : (
            <IconPhoneIn size={13} />
          )}
          {line.text}
        </span>
      </div>
    );
  }

  const isCaller = line.role === 'caller';
  return (
    <div className={cn('animate-fade-up flex items-end gap-2', isCaller ? 'justify-end' : 'justify-start')}>
      {!isCaller && (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-white">
          <IconSparkle size={14} />
        </div>
      )}
      <div className={cn('max-w-[82%]', isCaller && 'text-right')}>
        <div
          className={cn(
            'inline-block rounded-[14px] px-3.5 py-2.5 text-left text-[13.5px] leading-relaxed',
            isCaller
              ? 'rounded-br-[5px] bg-brand text-white'
              : 'rounded-bl-[5px] bg-surface-3 text-ink',
          )}
        >
          {line.text}
        </div>
        {(line.latency || line.cite || line.meta) && (
          <div
            className={cn(
              'mt-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-3',
              isCaller ? 'justify-end' : 'justify-start',
            )}
          >
            {line.latency && <span className="tabular">{line.latency} ms</span>}
            {line.cite && (
              <span className="inline-flex max-w-[240px] items-center gap-1 truncate rounded-full bg-brand-soft px-2 py-0.5 text-brand-ink">
                {line.cite}
              </span>
            )}
            {line.meta && (
              <span className="rounded-full bg-warning-soft px-2 py-0.5 text-warning">{line.meta}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
