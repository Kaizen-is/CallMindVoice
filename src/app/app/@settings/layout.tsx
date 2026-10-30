import { requireSession } from '@/lib/auth';
import { translator } from '@/lib/i18n';
import type { UiLocale } from '@/lib/types';
import { SettingsModalChrome, type SettingsSection } from '@/components/console/settings-modal';
import {
  IconUsers,
  IconCreditCard,
  IconCode,
  IconSettings,
} from '@/components/icons';

export const dynamic = 'force-dynamic';

/**
 * Layout for the `@settings` parallel slot. Stays mounted across section
 * switches so the modal chrome (backdrop + sidebar) persists while only the
 * content changes. Labels are resolved server-side from the caller's locale.
 */
export default async function SettingsSlotLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireSession();
  const t = translator((user.locale ?? 'uz') as UiLocale);

  const sections: SettingsSection[] = [
    { href: '/app/team', label: t('nav.team'), icon: <IconUsers size={16} /> },
    { href: '/app/billing', label: t('nav.billing'), icon: <IconCreditCard size={16} /> },
    { href: '/app/developers', label: t('nav.developers'), icon: <IconCode size={16} /> },
    { href: '/app/settings', label: t('nav.settings'), icon: <IconSettings size={16} /> },
  ];

  return (
    <SettingsModalChrome sections={sections} title={t('nav.section.manage')}>
      {children}
    </SettingsModalChrome>
  );
}
