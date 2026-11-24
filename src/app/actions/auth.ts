'use server';

import { redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { corePost } from '@/lib/core';
import { LOCALES, translator } from '@/lib/i18n';
import type { UiLocale } from '@/lib/types';

const SESSION_COOKIE = 'ovoz_session';

/** Store the session Python created, with the cookie attributes createSession always used. */
async function setSessionCookie(token: string, expires: string) {
  // Secure only when the edge connection is actually HTTPS (x-forwarded-proto); a Secure cookie
  // sent over plain http:// is never stored and the login would silently not stick.
  const proto = ((await headers()).get('x-forwarded-proto') ?? '').split(',')[0].trim();
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: proto === 'https',
    path: '/',
    expires: new Date(expires),
  });
}

export interface FormState {
  error?: string;
  ok?: boolean;
}


/** Translator bound to the visitor's `ovoz_locale` cookie (Uzbek default), so
 *  auth error messages come back in the same language as the login form. */
async function authTranslator() {
  const cookieLocale = (await cookies()).get('ovoz_locale')?.value as UiLocale | undefined;
  const locale = cookieLocale && LOCALES.includes(cookieLocale) ? cookieLocale : 'uz';
  return translator(locale);
}

export async function signUpAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const t = await authTranslator();
  // Python validates the form, creates the company, its owner, a first agent and a number
  // (provisionTenant) and the session; error messages come back as keys and are translated here.
  const result = await corePost<{ errorKey?: string; token?: string; expires?: string; redirect?: string }>(
    '/actions/signUpAction',
    {
      company: String(formData.get('company') ?? ''),
      name: String(formData.get('name') ?? ''),
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
      industry: String(formData.get('industry') ?? 'other'),
    },
  );
  if (result.errorKey || !result.token || !result.expires) return { error: t(result.errorKey ?? 'auth.err.createFailed') };
  await setSessionCookie(result.token, result.expires);
  redirect(result.redirect ?? '/onboarding');
}

export async function signInAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const t = await authTranslator();
  // Python checks the password, writes the session and the audit row (same message for a wrong
  // address or password — never reveal whether an address is registered).
  const result = await corePost<{ errorKey?: string; token?: string; expires?: string; redirect?: string }>(
    '/actions/signInAction',
    { email: String(formData.get('email') ?? ''), password: String(formData.get('password') ?? '') },
  );
  if (result.errorKey || !result.token || !result.expires) return { error: t(result.errorKey ?? 'auth.err.credentials') };
  await setSessionCookie(result.token, result.expires);
  redirect(result.redirect ?? '/app');
}

export async function signOutAction() {
  // Python writes the audit row and ends the session; the cookie is dropped here.
  await corePost('/actions/signOutAction');
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/login');
}

export async function setLocaleAction(locale: UiLocale) {
  if (!LOCALES.includes(locale)) return;
  await corePost('/actions/setLocaleAction', { locale });
  revalidatePath('/app', 'layout');
}

/**
 * Public locale switch — usable by signed-out visitors on the marketing site.
 * Persists to a year-long cookie, and mirrors into the user/tenant records when
 * a session exists so the console and the landing page stay in sync.
 *
 * Takes the form's `locale` field rather than a bound argument: a bound action
 * makes React add a hidden `$ACTION_n:m` field, which the edge proxy refuses
 * when the form is sent before the page's scripts run (see instrumentation-client.ts).
 */
export async function setPublicLocaleAction(formData: FormData) {
  const locale = String(formData.get('locale') ?? '') as UiLocale;
  if (!LOCALES.includes(locale)) return;
  (await cookies()).set('ovoz_locale', locale, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
  // Mirrored into the user and company records when signed in (Python).
  await corePost('/actions/setPublicLocaleAction', { locale });
  revalidatePath('/', 'layout');
}
