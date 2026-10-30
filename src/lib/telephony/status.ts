import 'server-only';

import * as twilio from './twilio';

export type TelephonyMode = 'asterisk' | 'twilio' | 'simulator';

/**
 * Deployment-level telephony status for the console.
 *
 * The Asterisk bridge authenticates with the shared secret, while Twilio uses
 * its account credentials. Both transports can exist in one deployment; the
 * self-hosted bridge is shown as the primary transport when it is configured.
 */
export function telephonyStatus() {
  const asteriskConfigured = Boolean(process.env.BRIDGE_SHARED_SECRET);
  const twilioConfigured = twilio.isConfigured();
  const mode: TelephonyMode = asteriskConfigured
    ? 'asterisk'
    : twilioConfigured
      ? 'twilio'
      : 'simulator';

  return {
    configured: asteriskConfigured || twilioConfigured,
    mode,
    accountSid: twilioConfigured ? `${twilio.accountSid().slice(0, 10)}…` : null,
  };
}
