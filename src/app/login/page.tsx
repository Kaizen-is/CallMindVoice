import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentSession } from '@/lib/auth';
import { AuthShell } from '@/components/auth/shell';
import { LoginForm } from './form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage() {
  const session = await currentSession();
  if (session) redirect(session.tenant.onboarded ? '/app' : '/onboarding');
  return (
    <AuthShell>
      <LoginForm />
    </AuthShell>
  );
}
