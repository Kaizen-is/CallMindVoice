'use server';

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { get, now, run } from '@/lib/db';
import { audit, createSession, currentSession, destroySession, requireSession, verifyPassword } from '@/lib/auth';
import { provisionTenant } from '@/lib/provision';
import { LOCALES, translator } from '@/lib/i18n';
import type { UiLocale, User } from '@/lib/types';

export interface FormState {
  error?: string;
  ok?: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Translator bound to the visitor's `ovoz_locale` cookie (Uzbek default), so
 *  auth error messages come back in the same language as the login form. */
async function authTranslator() {
  const cookieLocale = (await cookies()).get('ovoz_locale')?.value as UiLocale | undefined;
  const locale = cookieLocale && LOCALES.includes(cookieLocale) ? cookieLocale : 'uz';
  return translator(locale);
}

export async function signUpAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const t = await authTranslator();
  const company = String(formData.get('company') ?? '').trim();
  const fullName = String(formData.get('name') ?? '').trim();
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const industry = String(formData.get('industry') ?? 'other');

  if (company.length < 2) return { error: t('auth.err.company') };
  if (fullName.length < 2) return { error: t('auth.err.name') };
  if (!EMAIL_RE.test(email)) return { error: t('auth.err.email') };
  if (password.length < 8) return { error: t('auth.err.password') };

  let created: { tenantId: string; userId: string };
  try {
    created = provisionTenant({ company, industry, fullName, email, password });
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message.toLowerCase().includes('already exists')) {
      return { error: t('auth.err.emailExists') };
    }
    return { error: t('auth.err.createFailed') };
  }

  await createSession(created.userId, created.tenantId);
  redirect('/onboarding');
}

export async function signInAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const t = await authTranslator();
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');

  const user = get<User>('SELECT * FROM users WHERE email=?', email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    // Same message either way — never reveal whether an address is registered.
    return { error: t('auth.err.credentials') };
  }
  if (user.status === 'disabled') return { error: t('auth.err.disabled') };

  await createSession(user.id, user.tenant_id);
  audit(user.tenant_id, { id: user.id, name: user.name }, 'auth.signin', user.id);

  const tenant = get<{ onboarded: number }>('SELECT onboarded FROM tenants WHERE id=?', user.tenant_id);
  redirect(tenant?.onboarded ? '/app' : '/onboarding');
}

export async function signOutAction() {
  const session = await requireSession().catch(() => null);
  if (session) {
    audit(session.tenant.id, { id: session.user.id, name: session.user.name }, 'auth.signout');
  }
  await destroySession();
  redirect('/login');
}

export async function setLocaleAction(locale: UiLocale) {
  if (!LOCALES.includes(locale)) return;
  const { user, tenant } = await requireSession();
  run('UPDATE users SET locale=?, updated_at=? WHERE id=?', locale, now(), user.id);
  run('UPDATE tenants SET locale=?, updated_at=? WHERE id=?', locale, now(), tenant.id);
  revalidatePath('/app', 'layout');
}

/**
 * Public locale switch — usable by signed-out visitors on the marketing site.
 * Persists to a year-long cookie, and mirrors into the user/tenant records when
 * a session exists so the console and the landing page stay in sync.
 */
export async function setPublicLocaleAction(locale: UiLocale) {
  if (!LOCALES.includes(locale)) return;
  (await cookies()).set('ovoz_locale', locale, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
  const session = await currentSession();
  if (session) {
    run('UPDATE users SET locale=?, updated_at=? WHERE id=?', locale, now(), session.user.id);
    run('UPDATE tenants SET locale=?, updated_at=? WHERE id=?', locale, now(), session.tenant.id);
  }
  revalidatePath('/', 'layout');
}
