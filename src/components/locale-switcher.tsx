import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
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

/** Uzbek Latin, Uzbek Cyrillic, Russian, English — the picker order. */
const ORDER: UiLocale[] = ['uz', 'uz-Cyrl', 'ru', 'en'];

/**
 * Language picker for public pages (landing + auth).
 *
 * Deliberately built from a native `<details>` disclosure with one `<form>` per
 * language instead of a JS-state dropdown. It therefore opens **and** switches
 * with zero client-side hydration: a visitor can change language even if the
 * page's client bundle is slow to load, blocked by a browser extension, or fails
 * to hydrate for any other reason. Selecting a language posts to
 * `setPublicLocaleAction`, which writes the year-long `ovoz_locale` cookie and
 * revalidates — so the choice carries across the landing page, login and signup.
 * With JavaScript present, Next.js progressively enhances the form into a soft
 * refresh; without it, the browser simply reloads the page in the new language.
 */
export function LocaleSwitcher({ locale, className }: { locale: UiLocale; className?: string }) {
  return (
    <details className={cn('lang-switch relative', className)}>
      <summary
        aria-label="Change language"
        className="inline-flex h-9 cursor-pointer list-none items-center gap-2 rounded-[9px] px-2.5 text-[13px] text-ink-2 transition-colors select-none hover:bg-surface-3 hover:text-ink [&::-webkit-details-marker]:hidden"
      >
        {FLAG[locale]}
        <span className="hidden sm:inline">{LOCALE_SHORT[locale]}</span>
      </summary>

      <div className="lang-switch-menu absolute right-0 z-50 mt-1.5 w-[184px] overflow-hidden rounded-[12px] bg-overlay p-1 shadow-e3 hairline">
        {ORDER.map((code) => (
          <form key={code} action={setPublicLocaleAction.bind(null, code)}>
            <button
              type="submit"
              className={cn(
                'flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-surface-3',
                code === locale ? 'font-medium text-ink' : 'text-ink',
              )}
            >
              {FLAG[code]}
              {LOCALE_LABEL[code]}
            </button>
          </form>
        ))}
      </div>
    </details>
  );
}
