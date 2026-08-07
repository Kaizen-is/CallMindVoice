'use client';

import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Menu } from '@/components/ui/overlays';
import { FlagEN, FlagRU, FlagUZ } from '@/components/icons';
import { LOCALE_LABEL, LOCALE_SHORT } from '@/lib/i18n';
import { setPublicLocaleAction } from '@/app/actions/auth';
import type { UiLocale } from '@/lib/types';

const FLAG: Record<UiLocale, ReactNode> = {
  en: <FlagEN size={16} />,
  ru: <FlagRU size={16} />,
  uz: <FlagUZ size={16} />,
  'uz-Cyrl': <FlagUZ size={16} />,
};

/**
 * Language picker for public pages. Mirrors the console header switcher, but
 * writes an `ovoz_locale` cookie so it also works for signed-out visitors.
 */
export function LocaleSwitcher({ locale, className }: { locale: UiLocale; className?: string }) {
  const router = useRouter();
  const pick = (next: UiLocale) => async () => {
    await setPublicLocaleAction(next);
    router.refresh();
  };

  return (
    <Menu
      width={184}
      trigger={({ toggle }) => (
        <button
          onClick={toggle}
          aria-label="Change language"
          className={cn(
            'inline-flex h-9 items-center gap-2 rounded-[9px] px-2.5 text-[13px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink',
            className,
          )}
        >
          {FLAG[locale]}
          <span className="hidden sm:inline">{LOCALE_SHORT[locale]}</span>
        </button>
      )}
      items={[
        { label: LOCALE_LABEL.uz, icon: <FlagUZ size={16} />, onClick: pick('uz') },
        { label: LOCALE_LABEL['uz-Cyrl'], icon: <FlagUZ size={16} />, onClick: pick('uz-Cyrl') },
        { label: LOCALE_LABEL.ru, icon: <FlagRU size={16} />, onClick: pick('ru') },
        { label: LOCALE_LABEL.en, icon: <FlagEN size={16} />, onClick: pick('en') },
      ]}
    />
  );
}
