import 'server-only';
import { cookies } from 'next/headers';
import { LOCALES } from '@/lib/i18n';
import type { UiLocale } from '@/lib/types';

/**
 * Resolve the UI locale for a server-rendered public page.
 *
 * Order: a signed-in visitor's saved locale (passed in by the caller, which
 * usually already has the session in hand), then the `ovoz_locale` cookie the
 * header language switcher writes, then Uzbek (Latin) as the platform default.
 *
 * Keeping this in one place means the landing page, the login page and the
 * signup page all agree on which language an anonymous visitor sees — a
 * language picked on the marketing site carries straight into sign-in.
 */
export async function resolveUiLocale(savedLocale?: string | null): Promise<UiLocale> {
  if (savedLocale && LOCALES.includes(savedLocale as UiLocale)) {
    return savedLocale as UiLocale;
  }
  const cookieLocale = (await cookies()).get('ovoz_locale')?.value as UiLocale | undefined;
  return cookieLocale && LOCALES.includes(cookieLocale) ? cookieLocale : 'uz';
}
