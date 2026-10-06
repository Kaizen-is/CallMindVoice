/**
 * The demo's own icon set: one 24-unit grid, one 1.8 stroke, round joins.
 * The handset is filled, like the call buttons on a phone.
 */
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

const Svg = ({ children, ...props }: P) => (
  <svg
    viewBox="0 0 24 24"
    width={22}
    height={22}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    focusable="false"
    {...props}
  >
    {children}
  </svg>
);

const HANDSET =
  'M8.2 3.5H5.6A1.6 1.6 0 0 0 4 5.2c.3 8.1 6.7 14.5 14.8 14.8a1.6 1.6 0 0 0 1.7-1.6v-2.6a1.2 1.2 0 0 0-.9-1.2' +
  'l-3-.8a1.2 1.2 0 0 0-1.2.4l-1.1 1.4a12.4 12.4 0 0 1-5.9-5.9l1.4-1.1a1.2 1.2 0 0 0 .4-1.2l-.8-3a1.2 1.2 0 0 0-1.2-.9Z';

export const IconHandset = (p: P) => (
  <Svg strokeWidth={1.2} {...p}>
    <path d={HANDSET} fill="currentColor" />
  </Svg>
);

/** The handset laid down: hang up. */
export const IconHangUp = (p: P) => (
  <Svg strokeWidth={1.2} {...p}>
    <path d={HANDSET} fill="currentColor" transform="rotate(135 12 12)" />
  </Svg>
);

export const IconMic = (p: P) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </Svg>
);

export const IconMicOff = (p: P) => (
  <Svg {...p}>
    <path d="M15 9.4V6a3 3 0 0 0-5.8-1.1M9 9v2a3 3 0 0 0 4.9 2.3" />
    <path d="M18.5 11a6.4 6.4 0 0 1-.6 2.7M5.5 11a6.5 6.5 0 0 0 10.4 5.2M12 17.5V21M4 4l16 16" />
  </Svg>
);

export const IconPerson = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="8.2" r="3.6" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </Svg>
);

export const IconHeadset = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 14v-2a7.5 7.5 0 0 1 15 0v2" />
    <rect x="3.5" y="13" width="4" height="6" rx="1.6" />
    <rect x="16.5" y="13" width="4" height="6" rx="1.6" />
    <path d="M18.5 19c0 1.5-1.7 2.3-4.2 2.3H13" />
  </Svg>
);

export const IconAlert = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.8v5M12 16.2h.01" />
  </Svg>
);

export const IconLock = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="10.5" width="14" height="10" rx="2.4" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
  </Svg>
);
