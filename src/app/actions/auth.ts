'use server';

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { get, now, run } from '@/lib/db';
import { audit, createSession, currentSession, destroySession, requireSession, verifyPassword } from '@/lib/auth';
import { provisionTenant } from '@/lib/provision';
import { LOCALES } from '@/lib/i18n';
import type { UiLocale, User } from '@/lib/types';

export interface FormState {
  error?: string;
  ok?: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function signUpAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const company = String(formData.get('company') ?? '').trim();
  const fullName = String(formData.get('name') ?? '').trim();
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const industry = String(formData.get('industry') ?? 'other');

  if (company.length < 2) return { error: 'Please enter your company name.' };
  if (fullName.length < 2) return { error: 'Please enter your name.' };
  if (!EMAIL_RE.test(email)) return { error: 'That email address does not look right.' };
  if (password.length < 8) return { error: 'Use at least 8 characters for your password.' };

  let created: { tenantId: string; userId: string };
  try {
    created = provisionTenant({ company, industry, fullName, email, password });
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not create the account.' };
  }

  await createSession(created.userId, created.tenantId);
  redirect('/onboarding');
}

export async function signInAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');

  const user = get<User>('SELECT * FROM users WHERE email=?', email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    // Same message either way — never reveal whether an address is registered.
    return { error: 'Email or password is incorrect.' };
  }
  if (user.status === 'disabled') return { error: 'This account has been disabled.' };

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
