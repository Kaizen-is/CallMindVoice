import 'server-only';

export type TelephonyMode = 'asterisk' | 'simulator';

/**
 * Deployment-level telephony status for the console: the self-hosted Asterisk
 * bridge when its shared secret is set, otherwise the built-in simulator.
 */
export function telephonyStatus() {
  const asteriskConfigured = Boolean(process.env.BRIDGE_SHARED_SECRET);
  const mode: TelephonyMode = asteriskConfigured ? 'asterisk' : 'simulator';
  return { configured: asteriskConfigured, mode };
}
