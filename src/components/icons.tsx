import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/* ── navigation ─────────────────────────────────────────────── */
export const IconHome = (p: P) => (
  <Svg {...p}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.6V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.6" /></Svg>
);
export const IconBook = (p: P) => (
  <Svg {...p}><path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a2 2 0 0 0-2 2V4.5Z" /><path d="M8 7h8M8 11h5" /></Svg>
);
export const IconSparkle = (p: P) => (
  <Svg {...p}><path d="M12 3.2 13.7 8.6a3 3 0 0 0 1.9 1.9l5.4 1.7-5.4 1.7a3 3 0 0 0-1.9 1.9L12 21.2l-1.7-5.4a3 3 0 0 0-1.9-1.9L3 12.2l5.4-1.7a3 3 0 0 0 1.9-1.9L12 3.2Z" /><path d="M19 3v3M20.5 4.5h-3" /></Svg>
);
export const IconPhone = (p: P) => (
  <Svg {...p}><path d="M6.6 3.5h2.2l1.6 4-2 1.3a12.5 12.5 0 0 0 5.4 5.4l1.3-2 4 1.6v2.2a2.2 2.2 0 0 1-2.4 2.2C10.6 17.5 6 12.9 4.4 5.9A2.2 2.2 0 0 1 6.6 3.5Z" /></Svg>
);
export const IconPhoneIn = (p: P) => (
  <Svg {...p}><path d="M6.6 3.5h2.2l1.6 4-2 1.3a12.5 12.5 0 0 0 5.4 5.4l1.3-2 4 1.6v2.2a2.2 2.2 0 0 1-2.4 2.2C10.6 17.5 6 12.9 4.4 5.9A2.2 2.2 0 0 1 6.6 3.5Z" /><path d="M21 3l-5 5M16 3.6V8h4.4" /></Svg>
);
export const IconHeadset = (p: P) => (
  <Svg {...p}><path d="M4 13v-1a8 8 0 0 1 16 0v1" /><path d="M4 13h2.2a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5.5A1.5 1.5 0 0 1 4 17.5V13Z" /><path d="M20 13h-2.2a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h.7a1.5 1.5 0 0 0 1.5-1.5V13Z" /><path d="M19 19v.6a2.4 2.4 0 0 1-2.4 2.4H13" /></Svg>
);
export const IconChart = (p: P) => (
  <Svg {...p}><path d="M4 20V4" /><path d="M4 20h16" /><path d="M8 20v-6M12.7 20V8M17.3 20v-9" /></Svg>
);
export const IconWave = (p: P) => (
  <Svg {...p}><path d="M3 12h1.6M20.4 12H21" /><path d="M7 8.5v7M11 5v14M15 7.5v9M18 10v4" /></Svg>
);
export const IconUsers = (p: P) => (
  <Svg {...p}><circle cx="9" cy="8" r="3.2" /><path d="M2.8 20a6.2 6.2 0 0 1 12.4 0" /><path d="M16.5 5.3a3.2 3.2 0 0 1 0 6.1M17.6 14.4A6.2 6.2 0 0 1 21.2 20" /></Svg>
);
export const IconCreditCard = (p: P) => (
  <Svg {...p}><rect x="2.5" y="5" width="19" height="14" rx="2.6" /><path d="M2.5 9.6h19" /><path d="M6.2 14.6h3.4" /></Svg>
);
export const IconSettings = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 14a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.5 13H3.3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 6.3l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 2.4V2.3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.3 1Z" /></Svg>
);
export const IconCode = (p: P) => (
  <Svg {...p}><path d="M9 6.5 3.8 12 9 17.5M15 6.5 20.2 12 15 17.5" /></Svg>
);
export const IconInbox = (p: P) => (
  <Svg {...p}><path d="M3.5 13.5 5.8 5.4A2 2 0 0 1 7.7 4h8.6a2 2 0 0 1 1.9 1.4l2.3 8.1" /><path d="M3.5 13.5h4.2l1.1 2.4h6.4l1.1-2.4h4.2V18a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2v-4.5Z" /></Svg>
);
export const IconHash = (p: P) => (
  <Svg {...p}><path d="M9.5 3.5 7.8 20.5M16.2 3.5l-1.7 17M3.8 8.8h16.4M3 15.2h16.4" /></Svg>
);

/* ── actions ────────────────────────────────────────────────── */
export const IconPlus = (p: P) => (<Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>);
export const IconMinus = (p: P) => (<Svg {...p}><path d="M5 12h14" /></Svg>);
export const IconCheck = (p: P) => (<Svg {...p}><path d="m4.5 12.5 5 5 10-11" /></Svg>);
export const IconX = (p: P) => (<Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>);
export const IconSearch = (p: P) => (<Svg {...p}><circle cx="10.8" cy="10.8" r="6.8" /><path d="m15.8 15.8 4.4 4.4" /></Svg>);
export const IconUpload = (p: P) => (<Svg {...p}><path d="M12 16V4" /><path d="m7.5 8.5 4.5-4.5 4.5 4.5" /><path d="M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15" /></Svg>);
export const IconDownload = (p: P) => (<Svg {...p}><path d="M12 4v12" /><path d="m7.5 11.5 4.5 4.5 4.5-4.5" /><path d="M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15" /></Svg>);
export const IconTrash = (p: P) => (<Svg {...p}><path d="M4 6.5h16" /><path d="M9.5 6.5V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7" /><path d="M6.3 6.5 7 19.4a1.7 1.7 0 0 0 1.7 1.6h6.6a1.7 1.7 0 0 0 1.7-1.6l.7-12.9" /><path d="M10.4 10.4v6.4M13.6 10.4v6.4" /></Svg>);
export const IconEdit = (p: P) => (<Svg {...p}><path d="M4 20h4.2L19.4 8.8a2.1 2.1 0 0 0-3-3L5.2 17V20Z" /><path d="m14.8 5.4 3 3" /></Svg>);
export const IconCopy = (p: P) => (<Svg {...p}><rect x="8.5" y="8.5" width="12" height="12" rx="2.4" /><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></Svg>);
export const IconRefresh = (p: P) => (<Svg {...p}><path d="M20 12a8 8 0 1 1-2.6-5.9" /><path d="M20.4 4.2v4.4H16" /></Svg>);
export const IconPlay = (p: P) => (<Svg {...p}><path d="M7.5 4.8v14.4a.7.7 0 0 0 1.07.6l11.2-7.2a.7.7 0 0 0 0-1.2L8.57 4.2A.7.7 0 0 0 7.5 4.8Z" /></Svg>);
export const IconPause = (p: P) => (<Svg {...p}><path d="M8.5 4.5v15M15.5 4.5v15" /></Svg>);
export const IconStop = (p: P) => (<Svg {...p}><rect x="5.5" y="5.5" width="13" height="13" rx="2.5" /></Svg>);
export const IconSend = (p: P) => (<Svg {...p}><path d="M20.5 3.5 3.8 10.2a.6.6 0 0 0 .05 1.12l6.7 2.13 2.13 6.7a.6.6 0 0 0 1.12.05L20.5 3.5Z" /><path d="m10.6 13.4 4.4-4.4" /></Svg>);
export const IconMic = (p: P) => (<Svg {...p}><rect x="9" y="2.6" width="6" height="11.4" rx="3" /><path d="M5.2 11.4a6.8 6.8 0 0 0 13.6 0" /><path d="M12 18.2V21.4M8.6 21.4h6.8" /></Svg>);
export const IconMicOff = (p: P) => (<Svg {...p}><path d="M3.5 3.5 20.5 20.5" /><path d="M15 5.6A3 3 0 0 0 9 5.6v3.1M9 11.2v.4a3 3 0 0 0 4.6 2.55" /><path d="M5.2 11.4a6.8 6.8 0 0 0 10.1 5.9M18.8 11.4a6.7 6.7 0 0 1-.3 2" /><path d="M12 18.2V21.4M8.6 21.4h6.8" /></Svg>);
export const IconVolume = (p: P) => (<Svg {...p}><path d="M4 9.5h3l4.5-3.8a.6.6 0 0 1 1 .46v11.7a.6.6 0 0 1-1 .45L7 14.5H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z" /><path d="M16.5 9a4.2 4.2 0 0 1 0 6M19 6.4a7.8 7.8 0 0 1 0 11.2" /></Svg>);
export const IconLink = (p: P) => (<Svg {...p}><path d="M10.3 13.7a4 4 0 0 0 5.66 0l2.83-2.83a4 4 0 1 0-5.66-5.66l-1.4 1.4" /><path d="M13.7 10.3a4 4 0 0 0-5.66 0L5.2 13.1a4 4 0 0 0 5.66 5.66l1.4-1.4" /></Svg>);
export const IconExternal = (p: P) => (<Svg {...p}><path d="M13.5 4.5H19.5V10.5" /><path d="M19.5 4.5 11 13" /><path d="M18 14.5v4A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h4" /></Svg>);
export const IconFilter = (p: P) => (<Svg {...p}><path d="M4 5.5h16l-6.2 7.3v5.9l-3.6 1.8v-7.7L4 5.5Z" /></Svg>);
export const IconEye = (p: P) => (<Svg {...p}><path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3.1" /></Svg>);
export const IconEyeOff = (p: P) => (<Svg {...p}><path d="M3 3l18 18" /><path d="M10.6 6.1A9.7 9.7 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3.2 3.9M6.4 8.2A17 17 0 0 0 2.5 12S6 18 12 18a9.4 9.4 0 0 0 3.3-.6" /><path d="M9.9 9.9a3.1 3.1 0 0 0 4.2 4.2" /></Svg>);

/* ── status ─────────────────────────────────────────────────── */
export const IconAlert = (p: P) => (<Svg {...p}><path d="M10.3 3.9 2.6 17.2A1.9 1.9 0 0 0 4.3 20h15.4a1.9 1.9 0 0 0 1.7-2.8L13.7 3.9a1.9 1.9 0 0 0-3.4 0Z" /><path d="M12 9.2v4.1M12 16.6h.01" /></Svg>);
export const IconInfo = (p: P) => (<Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.8h.01" /></Svg>);
export const IconCheckCircle = (p: P) => (<Svg {...p}><circle cx="12" cy="12" r="9" /><path d="m8.2 12.3 2.6 2.6 5-5.4" /></Svg>);
export const IconClock = (p: P) => (<Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5.3l3.2 1.9" /></Svg>);
export const IconShield = (p: P) => (<Svg {...p}><path d="M12 3 5 5.8v5.5c0 4.3 2.9 8.2 7 9.7 4.1-1.5 7-5.4 7-9.7V5.8L12 3Z" /><path d="m9.2 12 2 2 3.6-3.9" /></Svg>);
export const IconZap = (p: P) => (<Svg {...p}><path d="M13.4 2.5 4.8 13.2a.6.6 0 0 0 .47.98H11l-.4 7.32a.6.6 0 0 0 1.07.4l8.6-10.7a.6.6 0 0 0-.47-.98H13l.4-7.32a.6.6 0 0 0-1-.4Z" /></Svg>);
export const IconGlobe = (p: P) => (<Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3.2 9.4h17.6M3.2 14.6h17.6" /><path d="M12 3a15 15 0 0 1 0 18A15 15 0 0 1 12 3Z" /></Svg>);
export const IconLock = (p: P) => (<Svg {...p}><rect x="4.5" y="10" width="15" height="10.5" rx="2.4" /><path d="M8 10V7.5a4 4 0 0 1 8 0V10" /></Svg>);
export const IconKey = (p: P) => (<Svg {...p}><circle cx="8" cy="15.5" r="4" /><path d="m10.9 12.6 8-8M16.8 6.7l2.1 2.1M14.6 8.9l2.1 2.1" /></Svg>);
export const IconLogout = (p: P) => (<Svg {...p}><path d="M14 4.5h4A1.5 1.5 0 0 1 19.5 6v12a1.5 1.5 0 0 1-1.5 1.5h-4" /><path d="M10 8.5 6 12l4 3.5M6.4 12H15" /></Svg>);
export const IconBell = (p: P) => (<Svg {...p}><path d="M6 10a6 6 0 1 1 12 0c0 3.4.8 5.1 1.6 6.1a.6.6 0 0 1-.47.97H4.87a.6.6 0 0 1-.47-.97C5.2 15.1 6 13.4 6 10Z" /><path d="M9.8 20.2a2.4 2.4 0 0 0 4.4 0" /></Svg>);

/* ── files ──────────────────────────────────────────────────── */
export const IconFile = (p: P) => (<Svg {...p}><path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L13.5 3Z" /><path d="M13.2 3.2v4.1a1.2 1.2 0 0 0 1.2 1.2h4.2" /></Svg>);
export const IconFileText = (p: P) => (<Svg {...p}><path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L13.5 3Z" /><path d="M13.2 3.2v4.1a1.2 1.2 0 0 0 1.2 1.2h4.2" /><path d="M8.6 13h6.8M8.6 16.4h4.6" /></Svg>);
export const IconFolder = (p: P) => (<Svg {...p}><path d="M3.5 6.6A1.6 1.6 0 0 1 5.1 5h3.6a1.6 1.6 0 0 1 1.28.64l1.02 1.36h7.9A1.6 1.6 0 0 1 20.5 8.6v9.8a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6V6.6Z" /></Svg>);
export const IconDatabase = (p: P) => (<Svg {...p}><ellipse cx="12" cy="6" rx="7.5" ry="3" /><path d="M4.5 6v12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V6" /><path d="M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3" /></Svg>);

/* ── chevrons ───────────────────────────────────────────────── */
export const IconChevronRight = (p: P) => (<Svg {...p}><path d="m9.5 5.5 6.5 6.5-6.5 6.5" /></Svg>);
export const IconChevronLeft = (p: P) => (<Svg {...p}><path d="m14.5 5.5-6.5 6.5 6.5 6.5" /></Svg>);
export const IconChevronDown = (p: P) => (<Svg {...p}><path d="m5.5 9 6.5 6.5L18.5 9" /></Svg>);
export const IconChevronUp = (p: P) => (<Svg {...p}><path d="m5.5 15 6.5-6.5L18.5 15" /></Svg>);
export const IconArrowRight = (p: P) => (<Svg {...p}><path d="M4 12h15.5M13.5 6l6 6-6 6" /></Svg>);
export const IconArrowLeft = (p: P) => (<Svg {...p}><path d="M20 12H4.5M10.5 6l-6 6 6 6" /></Svg>);
export const IconArrowUpRight = (p: P) => (<Svg {...p}><path d="M6.5 17.5 17.5 6.5" /><path d="M8.4 6.5h9.1v9.1" /></Svg>);
export const IconTrendUp = (p: P) => (<Svg {...p}><path d="m3.5 16.5 5.2-5.2 3.4 3.4 6.9-7.2" /><path d="M14.6 7.5h4.9v4.9" /></Svg>);
export const IconTrendDown = (p: P) => (<Svg {...p}><path d="m3.5 7.5 5.2 5.2 3.4-3.4 6.9 7.2" /><path d="M14.6 16.5h4.9v-4.9" /></Svg>);
export const IconMore = (p: P) => (<Svg {...p}><circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" /></Svg>);
export const IconMenu = (p: P) => (<Svg {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Svg>);

/* ── theme ──────────────────────────────────────────────────── */
export const IconSun = (p: P) => (<Svg {...p}><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" /></Svg>);
export const IconMoon = (p: P) => (<Svg {...p}><path d="M20.5 14.4A8.8 8.8 0 0 1 9.6 3.5a8.8 8.8 0 1 0 10.9 10.9Z" /></Svg>);

/* ── brand ──────────────────────────────────────────────────── */
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="ovoz-g" x1="4" y1="3" x2="28" y2="29" gradientUnits="userSpaceOnUse">
          <stop stopColor="rgb(var(--brand))" />
          <stop offset="1" stopColor="rgb(var(--violet))" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="29" height="29" rx="9" fill="url(#ovoz-g)" />
      <g stroke="white" strokeWidth="2.1" strokeLinecap="round" opacity="0.96">
        <path d="M10 13.2v5.6" />
        <path d="M13.6 9.8v12.4" />
        <path d="M17.2 12v8" />
        <path d="M20.8 14.6v2.8" />
      </g>
    </svg>
  );
}

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <Logo size={26} />
      <span className="text-[17px] font-semibold tracking-[-0.02em]">Ovoz</span>
    </span>
  );
}

/* ── flags (locale switcher) ────────────────────────────────── */
export function FlagUZ({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.66} viewBox="0 0 30 20" className="rounded-[2px]" aria-hidden="true">
      <rect width="30" height="6.4" fill="#0099B5" />
      <rect y="6.4" width="30" height="7.2" fill="#fff" />
      <rect y="13.6" width="30" height="6.4" fill="#1EB53A" />
      <rect y="6.1" width="30" height="0.5" fill="#CE1126" />
      <rect y="13.4" width="30" height="0.5" fill="#CE1126" />
      <circle cx="7" cy="3.4" r="2.2" fill="#fff" />
      <circle cx="7.9" cy="3.1" r="2.2" fill="#0099B5" />
    </svg>
  );
}
export function FlagRU({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.66} viewBox="0 0 30 20" className="rounded-[2px]" aria-hidden="true">
      <rect width="30" height="6.67" fill="#fff" />
      <rect y="6.67" width="30" height="6.66" fill="#0039A6" />
      <rect y="13.33" width="30" height="6.67" fill="#D52B1E" />
    </svg>
  );
}
export function FlagEN({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.66} viewBox="0 0 30 20" className="rounded-[2px]" aria-hidden="true">
      <rect width="30" height="20" fill="#012169" />
      <path d="M0 0l30 20M30 0L0 20" stroke="#fff" strokeWidth="4" />
      <path d="M0 0l30 20M30 0L0 20" stroke="#C8102E" strokeWidth="2" />
      <path d="M15 0v20M0 10h30" stroke="#fff" strokeWidth="6" />
      <path d="M15 0v20M0 10h30" stroke="#C8102E" strokeWidth="3.4" />
    </svg>
  );
}
