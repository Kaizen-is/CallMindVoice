import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentSession } from '@/lib/auth';
import { resolveUiLocale } from '@/lib/locale-server';
import { translator } from '@/lib/i18n';
import { AuthShell } from '@/components/auth/shell';
import { SignupForm } from './form';

export async function generateMetadata(): Promise<Metadata> {
  const t = translator(await resolveUiLocale());
  return { title: t('auth.signup.formTitle') };
}

export default async function SignupPage() {
  const session = await currentSession();
  if (session) redirect(session.tenant.onboarded ? '/app' : '/onboarding');
  const locale = await resolveUiLocale();
  return (
    <AuthShell locale={locale}>
      <SignupForm locale={locale} />
    </AuthShell>
  );
}
