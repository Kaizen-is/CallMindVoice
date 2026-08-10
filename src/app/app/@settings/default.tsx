import { SettingsModalSignal } from '@/components/console/settings-modal';

// No section intercepted — signal the chrome to stay closed.
export default function SettingsSlotDefault() {
  return <SettingsModalSignal open={false} />;
}
