import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentSession } from '@/lib/auth';
import { AuthShell } from '@/components/auth/shell';
import { SignupForm } from './form';

export const metadata: Metadata = { title: 'Create your agent' };

export default async function SignupPage() {
  const session = await currentSession();
  if (session) redirect(session.tenant.onboarded ? '/app' : '/onboarding');
  return (
    <AuthShell>
      <SignupForm />
    </AuthShell>
  );
}
