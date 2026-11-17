import type { Metadata } from 'next';
import type { ComponentProps } from 'react';
import { redirect } from 'next/navigation';
import { currentSession } from '@/lib/auth';
import { coreGet } from '@/lib/core';
import { translator } from '@/lib/i18n';
import { OnboardingWizard } from './wizard';

export async function generateMetadata(): Promise<Metadata> {
  const session = await currentSession();
  const t = translator(session?.user.locale ?? 'uz');
  return { title: t('onboarding.metaTitle', 'Set up your agent') };
}
export const dynamic = 'force-dynamic';

type WizardProps = ComponentProps<typeof OnboardingWizard>;
/** The wizard's data, from the Python backend (`GET /views/onboarding`). */
type OnboardingData = Pick<WizardProps, 'packTitle' | 'packDescription' | 'agent' | 'documents' | 'phoneNumber'>;

export default async function OnboardingPage() {
  const session = await currentSession();
  if (!session) redirect('/login');
  if (session.tenant.onboarded) redirect('/app');

  const data = await coreGet<OnboardingData>('/views/onboarding');

  return (
    <OnboardingWizard
      locale={session.user.locale}
      company={session.tenant.name}
      userName={session.user.name}
      industry={session.tenant.industry}
      packTitle={data.packTitle}
      packDescription={data.packDescription}
      agent={data.agent}
      documents={data.documents}
      phoneNumber={data.phoneNumber}
    />
  );
}
