'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createDesignVoiceAction } from '@/app/actions/voices';
import { translator } from '@/lib/i18n';
import type { UiLocale } from '@/lib/types';
import { Button, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Field, Input } from '@/components/ui/forms';
import { useToast } from '@/components/ui/overlays';
import { IconAlert, IconSparkle, IconVolume } from '@/components/icons';
import { SavedVoiceList, usePreview, type SavedVoice } from '../voices/voice-shared';

/** The only attribute words the TTS v2 API accepts, grouped for the picker. */
const GROUPS: Array<{ key: string; label: string; exclusive: boolean; words: string[] }> = [
  { key: 'gender', label: 'Gender', exclusive: true, words: ['male', 'female'] },
  { key: 'age', label: 'Age', exclusive: true, words: ['child', 'teenager', 'young adult', 'middle-aged', 'elderly'] },
  {
    key: 'pitch',
    label: 'Pitch',
    exclusive: true,
    words: ['very low pitch', 'low pitch', 'moderate pitch', 'high pitch', 'very high pitch'],
  },
  { key: 'effect', label: 'Effect', exclusive: false, words: ['whisper'] },
  {
    key: 'accent',
    label: 'Accent',
    exclusive: true,
    words: [
      'american accent', 'british accent', 'australian accent', 'canadian accent', 'indian accent',
      'chinese accent', 'japanese accent', 'korean accent', 'russian accent', 'portuguese accent',
    ],
  },
];

export function DesignLab({
  locale,
  voices,
  speech,
}: {
  locale: UiLocale;
  voices: SavedVoice[];
  speech: { tts: boolean };
}) {
  const t = translator(locale);
  const toast = useToast();
  const router = useRouter();
  const { prefetch } = usePreview(locale);

  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>(['female', 'young adult', 'moderate pitch']);
  const [busy, setBusy] = useState(false);

  const toggle = (group: (typeof GROUPS)[number], word: string) => {
    setSelected((cur) => {
      if (cur.includes(word)) return cur.filter((w) => w !== word);
      const cleaned = group.exclusive ? cur.filter((w) => !group.words.includes(w)) : cur;
      return [...cleaned, word];
    });
  };

  const groupLabel = (key: string, fallback: string) =>
    t(`dev.voiceDesign.group.${key}`, fallback);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await createDesignVoiceAction({ name, attributes: selected });
      if (!res.ok) {
        toast.error(t('dev.voices.saveFail', 'Could not save the voice'), res.message);
        return;
      }
      toast.toast({ tone: 'success', title: t('dev.voiceDesign.saved', 'Voice designed and saved') });
      setName('');
      router.refresh();
      prefetch(res.voiceId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full">
      <PageHeader
        title={t('dev.voiceDesign.title', 'Voice design')}
        subtitle={t('dev.voiceDesign.subtitle', 'Describe a voice with attributes — gender, age, pitch, accent — and save it as your own named voice.')}
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <Card padded={false}>
          <div className="flex items-center gap-2 px-5 py-4 hairline-b">
            <IconSparkle size={16} className="text-ink-3" />
            <h3 className="text-[14px] font-semibold text-ink">{t('dev.voiceDesign.formTitle', 'New designed voice')}</h3>
          </div>

          {!speech.tts ? (
            <EmptyState
              icon={<IconAlert size={20} />}
              title={t('dev.tts.notConfiguredTitle')}
              description={t('dev.tts.notConfiguredBody')}
            />
          ) : (
            <div className="space-y-5 p-5">
              <Field label={t('dev.voices.nameLabel', 'Voice name')}>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('dev.voiceDesign.namePlaceholder', 'e.g. Young narrator')}
                  maxLength={60}
                />
              </Field>

              {GROUPS.map((g) => (
                <div key={g.key}>
                  <div className="mb-2 text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
                    {groupLabel(g.key, g.label)}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {g.words.map((w) => {
                      const on = selected.includes(w);
                      return (
                        <button
                          key={w}
                          type="button"
                          onClick={() => toggle(g, w)}
                          className={`rounded-full px-3 py-1.5 text-[12.5px] font-medium transition-colors hairline ${
                            on
                              ? 'bg-brand text-white'
                              : 'bg-surface-2 text-ink-2 hover:bg-surface-3 hover:text-ink'
                          }`}
                        >
                          {w}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              <div className="rounded-[10px] bg-surface-2 p-3 font-mono text-[12px] text-ink-2">
                {selected.length ? selected.join(', ') : t('dev.voiceDesign.emptySelection', 'pick at least one attribute')}
              </div>

              <Button
                variant="primary"
                full
                loading={busy}
                disabled={!name.trim() || !selected.length}
                icon={!busy ? <IconVolume size={15} /> : undefined}
                onClick={() => void submit()}
              >
                {busy ? t('dev.voiceDesign.saving', 'Saving…') : t('dev.voiceDesign.save', 'Save voice and hear it')}
              </Button>
            </div>
          )}
        </Card>

        <SavedVoiceList
          locale={locale}
          voices={voices}
          emptyTitle={t('dev.voiceDesign.emptyTitle', 'No designed voices yet')}
          emptyBody={t('dev.voiceDesign.emptyBody', 'Designed voices appear here and in every voice picker.')}
        />
      </div>
    </div>
  );
}
