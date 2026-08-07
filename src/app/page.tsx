import Link from 'next/link';
import { CallDemo } from '@/components/marketing/call-demo';
import { RoiCalculator } from '@/components/marketing/roi-calculator';
import { ThemeToggle } from '@/components/theme-toggle';
import { LinkButton } from '@/components/ui/primitives';
import { PLANS } from '@/lib/catalog';
import { fmtInt, fmtMoney } from '@/lib/utils';
import {
  FlagEN,
  FlagRU,
  FlagUZ,
  IconArrowRight,
  IconBook,
  IconChart,
  IconCheck,
  IconCode,
  IconDatabase,
  IconGlobe,
  IconHeadset,
  IconLock,
  IconPhone,
  IconShield,
  IconSparkle,
  IconUpload,
  IconZap,
  Logo,
  Wordmark,
} from '@/components/icons';
import { currentSession } from '@/lib/auth';
import { resolveUiLocale } from '@/lib/locale-server';
import { translator, type Translate } from '@/lib/i18n';
import { LocaleSwitcher } from '@/components/locale-switcher';
import type { UiLocale } from '@/lib/types';

export default async function LandingPage() {
  const session = await currentSession();
  // Signed-in visitors follow their saved locale; anonymous visitors follow the
  // `ovoz_locale` cookie set by the header switcher; otherwise default to Uzbek (Latin).
  const locale = await resolveUiLocale(session?.user.locale);
  const t = translator(locale);

  return (
    <div className="relative">
      <Nav signedIn={Boolean(session)} locale={locale} t={t} />
      <Hero signedIn={Boolean(session)} t={t} />
      <Problem t={t} />
      <HowItWorks t={t} />
      <Languages t={t} />
      <Features t={t} />
      <Latency t={t} />
      <Roi t={t} locale={locale} />
      <Pricing t={t} />
      <Security t={t} />
      <FinalCta t={t} />
      <Footer t={t} />
    </div>
  );
}

/* ═══ nav ═══════════════════════════════════════════════════════ */

function Nav({ signedIn, locale, t }: { signedIn: boolean; locale: UiLocale; t: Translate }) {
  const links: Array<[string, string]> = [
    [t('lp.nav.how'), '#how'],
    [t('lp.nav.languages'), '#languages'],
    [t('lp.nav.platform'), '#features'],
    [t('lp.nav.roi'), '#roi'],
    [t('lp.nav.pricing'), '#pricing'],
  ];
  return (
    // suppressHydrationWarning: some browser extensions inject attributes (e.g.
    // `zn_id`) onto the sticky header before React hydrates; this stops that
    // extension noise from tripping a hydration mismatch on this element.
    <header className="sticky top-0 z-50 w-full glass hairline-b" suppressHydrationWarning>
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-5">
        <Link href="/" className="shrink-0">
          <Wordmark />
        </Link>
        <nav className="hidden items-center gap-1 md:flex">
          {links.map(([label, href]) => (
            <a
              key={href}
              href={href}
              className="rounded-[8px] px-3 py-2 text-[13.5px] font-medium text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <LocaleSwitcher locale={locale} />
          <ThemeToggle />
          {signedIn ? (
            <LinkButton href="/app" variant="primary" size="sm" iconRight={<IconArrowRight size={14} />}>
              {t('lp.nav.openConsole')}
            </LinkButton>
          ) : (
            <>
              <LinkButton href="/login" variant="ghost" size="sm" className="hidden sm:inline-flex">
                {t('lp.nav.signin')}
              </LinkButton>
              <LinkButton href="/signup" variant="primary" size="sm">
                {t('lp.nav.startFree')}
              </LinkButton>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

/* ═══ hero ══════════════════════════════════════════════════════ */

function Hero({ signedIn, t }: { signedIn: boolean; t: Translate }) {
  return (
    <section className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 grid-bg" />
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[560px] w-[1100px] -translate-x-1/2 aurora opacity-70" />

      <div className="relative mx-auto max-w-6xl px-5 pt-16 pb-20 sm:pt-24 sm:pb-28">
        <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_1fr] lg:gap-16">
          <div>
            <div className="animate-fade-up inline-flex items-center gap-2 rounded-full bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink-2 shadow-e1 hairline">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-70" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand" />
              </span>
              {t('lp.hero.badge')}
            </div>

            <h1
              className="animate-fade-up mt-6 text-[42px] leading-[1.04] font-semibold tracking-[-0.035em] text-balance-pretty sm:text-[56px]"
              style={{ animationDelay: '60ms' }}
            >
              {t('lp.hero.title1')}
              <br />
              <span className="brand-gradient-text">{t('lp.hero.title2')}</span>
            </h1>

            <p
              className="animate-fade-up mt-6 max-w-xl text-[17px] leading-relaxed text-ink-2 text-balance-pretty"
              style={{ animationDelay: '120ms' }}
            >
              {t('lp.hero.sub')}
            </p>

            <div
              className="animate-fade-up mt-8 flex flex-wrap items-center gap-3"
              style={{ animationDelay: '180ms' }}
            >
              <LinkButton
                href={signedIn ? '/app' : '/signup'}
                variant="primary"
                size="lg"
                iconRight={<IconArrowRight size={16} />}
              >
                {signedIn ? t('lp.hero.ctaConsole') : t('lp.hero.ctaStart')}
              </LinkButton>
              <LinkButton href="/login" variant="secondary" size="lg" icon={<IconPhone size={16} />}>
                {t('lp.hero.ctaDemo')}
              </LinkButton>
            </div>

            <div
              className="animate-fade-up mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-ink-3"
              style={{ animationDelay: '240ms' }}
            >
              {[t('lp.hero.trust1'), t('lp.hero.trust2'), t('lp.hero.trust3')].map((label) => (
                <span key={label} className="inline-flex items-center gap-1.5">
                  <IconCheck size={14} className="text-success" />
                  {label}
                </span>
              ))}
            </div>
          </div>

          <div className="animate-fade-up lg:pl-4" style={{ animationDelay: '300ms' }}>
            <CallDemo />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ═══ problem ═══════════════════════════════════════════════════ */

function Problem({ t }: { t: Translate }) {
  const stats = [
    { value: '~$500', label: t('lp.problem.stat1') },
    { value: '70–90%', label: t('lp.problem.stat2') },
    { value: '<1 sec', label: t('lp.problem.stat3') },
  ];
  return (
    <section className="hairline-y border-y bg-sunken">
      <div className="mx-auto max-w-6xl px-5 py-14">
        <div className="grid gap-8 sm:grid-cols-3">
          {stats.map((s) => (
            <div key={s.label}>
              <div className="text-[34px] leading-none font-semibold tracking-[-0.03em] text-ink tabular">
                {s.value}
              </div>
              <p className="mt-2 max-w-[280px] text-[13.5px] leading-relaxed text-ink-3">{s.label}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ═══ how it works ══════════════════════════════════════════════ */

function HowItWorks({ t }: { t: Translate }) {
  const steps = [
    { icon: <IconUpload size={19} />, title: t('lp.how.s1t'), body: t('lp.how.s1b') },
    { icon: <IconDatabase size={19} />, title: t('lp.how.s2t'), body: t('lp.how.s2b') },
    { icon: <IconPhone size={19} />, title: t('lp.how.s3t'), body: t('lp.how.s3b') },
  ];

  return (
    <section id="how" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-24">
      <SectionHead eyebrow={t('lp.how.eyebrow')} title={t('lp.how.title')} subtitle={t('lp.how.sub')} />
      <div className="mt-14 grid gap-6 md:grid-cols-3">
        {steps.map((s, i) => (
          <div key={s.title} className="relative rounded-[16px] bg-surface p-6 shadow-e1 hairline">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-brand-soft text-brand-ink">
                {s.icon}
              </div>
              <span className="text-[13px] font-semibold text-ink-3 tabular">0{i + 1}</span>
            </div>
            <h3 className="text-[16px] font-semibold text-ink">{s.title}</h3>
            <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ═══ languages ═════════════════════════════════════════════════ */

function Languages({ t }: { t: Translate }) {
  const features = [
    { title: t('lp.lang.f1t'), desc: t('lp.lang.f1d') },
    { title: t('lp.lang.f2t'), desc: t('lp.lang.f2d') },
    { title: t('lp.lang.f3t'), desc: t('lp.lang.f3d') },
  ];
  // Sample dialogue stays in its own language — it demonstrates the languages
  // themselves, so it is intentionally not driven by the UI locale.
  const cards = [
    { flag: <FlagUZ size={26} />, name: 'O‘zbekcha', sample: 'Kardiolog qabuli qancha turadi?', reply: 'Kardiolog qabuli 180 000 so‘m.' },
    { flag: <FlagRU size={26} />, name: 'Русский', sample: 'Вы принимаете страховой полис?', reply: 'Да, мы работаем с четырьмя страховыми.' },
    { flag: <FlagEN size={26} />, name: 'English', sample: 'What time do you close on Saturdays?', reply: 'Saturdays we are open 10 until 3.' },
  ];

  return (
    <section id="languages" className="scroll-mt-20 hairline-y border-y bg-sunken">
      <div className="mx-auto max-w-6xl px-5 py-24">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <SectionHead
              align="left"
              eyebrow={t('lp.lang.eyebrow')}
              title={t('lp.lang.title')}
              subtitle={t('lp.lang.sub')}
            />
            <ul className="mt-8 space-y-4">
              {features.map((f) => (
                <li key={f.title} className="flex gap-3">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
                    <IconCheck size={12} strokeWidth={3} />
                  </span>
                  <div>
                    <div className="text-[14px] font-medium text-ink">{f.title}</div>
                    <p className="mt-0.5 text-[13px] leading-relaxed text-ink-3">{f.desc}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="grid gap-4">
            {cards.map((l) => (
              <div key={l.name} className="rounded-[14px] bg-surface p-5 shadow-e1 hairline">
                <div className="mb-3 flex items-center gap-2.5">
                  {l.flag}
                  <span className="text-[13.5px] font-semibold text-ink">{l.name}</span>
                </div>
                <p className="text-[13.5px] text-ink-2">“{l.sample}”</p>
                <p className="mt-2 flex items-start gap-2 text-[13.5px] text-ink">
                  <IconSparkle size={14} className="mt-0.5 shrink-0 text-brand" />
                  {l.reply}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ═══ features ══════════════════════════════════════════════════ */

function Features({ t }: { t: Translate }) {
  const features = [
    { icon: <IconShield size={18} />, title: t('lp.feat.f1t'), body: t('lp.feat.f1b') },
    { icon: <IconHeadset size={18} />, title: t('lp.feat.f2t'), body: t('lp.feat.f2b') },
    { icon: <IconBook size={18} />, title: t('lp.feat.f3t'), body: t('lp.feat.f3b') },
    { icon: <IconChart size={18} />, title: t('lp.feat.f4t'), body: t('lp.feat.f4b') },
    { icon: <IconGlobe size={18} />, title: t('lp.feat.f5t'), body: t('lp.feat.f5b') },
    { icon: <IconCode size={18} />, title: t('lp.feat.f6t'), body: t('lp.feat.f6b') },
  ];

  return (
    <section id="features" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-24">
      <SectionHead eyebrow={t('lp.feat.eyebrow')} title={t('lp.feat.title')} subtitle={t('lp.feat.sub')} />
      <div className="mt-14 grid gap-px overflow-hidden rounded-[18px] bg-[rgb(var(--line)/var(--line-alpha))] sm:grid-cols-2 lg:grid-cols-3">
        {features.map((f) => (
          <div key={f.title} className="bg-surface p-6 transition-colors hover:bg-surface-2">
            <div className="mb-3.5 flex h-9 w-9 items-center justify-center rounded-[10px] bg-surface-3 text-ink-2">
              {f.icon}
            </div>
            <h3 className="text-[15px] font-semibold text-ink">{f.title}</h3>
            <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">{f.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ═══ latency ═══════════════════════════════════════════════════ */

function Latency({ t }: { t: Translate }) {
  const budget = [
    { label: t('lp.lat.b1'), ms: 180, tone: 'bg-brand' },
    { label: t('lp.lat.b2'), ms: 45, tone: 'bg-violet' },
    { label: t('lp.lat.b3'), ms: 240, tone: 'bg-teal' },
    { label: t('lp.lat.b4'), ms: 120, tone: 'bg-success' },
  ];
  const total = budget.reduce((a, b) => a + b.ms, 0);
  const steps = [t('lp.lat.step1'), t('lp.lat.step2'), t('lp.lat.step3'), t('lp.lat.step4')];

  return (
    <section className="hairline-y border-y bg-sunken">
      <div className="mx-auto max-w-6xl px-5 py-24">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <SectionHead
              align="left"
              eyebrow={t('lp.lat.eyebrow')}
              title={t('lp.lat.title')}
              subtitle={t('lp.lat.sub')}
            />
            <div className="mt-8 rounded-[14px] bg-surface p-5 shadow-e1 hairline">
              <div className="flex items-baseline justify-between">
                <span className="text-[12.5px] font-medium text-ink-2">{t('lp.lat.target')}</span>
                <span className="text-[22px] font-semibold text-ink tabular">{total} ms</span>
              </div>
              <div className="mt-4 flex h-2.5 w-full overflow-hidden rounded-full">
                {budget.map((b) => (
                  <div key={b.label} className={b.tone} style={{ width: `${(b.ms / total) * 100}%` }} />
                ))}
              </div>
              <div className="mt-4 space-y-2.5">
                {budget.map((b) => (
                  <div key={b.label} className="flex items-center justify-between text-[13px]">
                    <span className="flex items-center gap-2 text-ink-2">
                      <span className={`h-2 w-2 rounded-full ${b.tone}`} />
                      {b.label}
                    </span>
                    <span className="text-ink tabular">{b.ms} ms</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-[18px] bg-surface p-7 shadow-e2 hairline">
            <div className="mb-5 flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-brand-soft text-brand-ink">
                <IconZap size={18} />
              </div>
              <h3 className="text-[15.5px] font-semibold text-ink">{t('lp.lat.arranged')}</h3>
            </div>
            <ol className="space-y-4">
              {steps.map((step, i) => (
                <li key={i} className="flex gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[11.5px] font-semibold text-ink-2 tabular">
                    {i + 1}
                  </span>
                  <p className="pt-0.5 text-[13.5px] leading-relaxed text-ink-2">{step}</p>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ═══ roi ═══════════════════════════════════════════════════════ */

function Roi({ t, locale }: { t: Translate; locale: UiLocale }) {
  return (
    <section id="roi" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-24">
      <SectionHead eyebrow={t('lp.roi.eyebrow')} title={t('lp.roi.title')} subtitle={t('lp.roi.sub')} />
      <div className="mt-12 rounded-[20px] bg-surface p-7 shadow-e2 hairline sm:p-9">
        <RoiCalculator locale={locale} />
      </div>
    </section>
  );
}

/* ═══ pricing ═══════════════════════════════════════════════════ */

function Pricing({ t }: { t: Translate }) {
  const minU = t('lp.roicalc.min');
  const perMo = t('lp.price.perMonth');
  const callsU = t('lp.price.callsUnit');
  const get = (id: string) => PLANS.find((p) => p.id === id)!;

  // Numbers come from the catalog (single source of truth); only the words are
  // localised — so a price change never has to be re-typed in four languages.
  const paid = (
    id: string,
    o: { blurb: string; features: string[]; cta: string; href: string; highlight?: boolean; custom?: boolean },
  ) => {
    const p = get(id);
    return {
      name: p.name,
      price: o.custom ? t('lp.price.custom') : fmtMoney(p.priceUsd, 'USD', 0),
      note: o.custom ? t('lp.price.annual') : perMo,
      allowance: `${fmtInt(p.minutesIncluded)} ${minU} ${perMo}`,
      meta: `≈ ${fmtInt(p.callsIncluded)} ${callsU} · ${t('lp.price.over')} ${fmtMoney(p.overagePerMinute, 'USD', 3)}/${minU}`,
      blurb: o.blurb,
      features: o.features,
      cta: o.cta,
      href: o.href,
      highlight: Boolean(o.highlight),
    };
  };

  const paygPlan = get('payg');
  const payg = {
    name: paygPlan.name,
    price: fmtMoney(paygPlan.overagePerMinute, 'USD', 3),
    note: `/ ${minU}`,
    allowance: t('lp.price.paygMetered'),
    meta: '',
    blurb: t('lp.price.p0blurb'),
    features: [t('lp.price.p1f2'), t('lp.price.p0f2'), t('lp.price.p0f3')],
    cta: t('lp.price.ctaTrial'),
    href: '/signup',
    highlight: false,
  };

  const plans = [
    payg,
    paid('start', {
      blurb: t('lp.price.p1blurb'),
      features: [t('lp.price.p1f2'), t('lp.price.p1f3'), t('lp.price.p1f4'), t('lp.price.p1f5')],
      cta: t('lp.price.ctaTrial'),
      href: '/signup',
    }),
    paid('pro', {
      blurb: t('lp.price.p2blurb'),
      features: [t('lp.price.p2f2'), t('lp.price.p2f4'), t('lp.price.p2f5'), t('lp.price.p2f6')],
      cta: t('lp.price.ctaTrial'),
      href: '/signup',
      highlight: true,
    }),
    paid('enterprise', {
      blurb: t('lp.price.p3blurb'),
      features: [t('lp.price.p3f2'), t('lp.price.p3f3'), t('lp.price.p3f4'), t('lp.price.p3f5')],
      cta: t('lp.price.ctaTalk'),
      href: '/signup?plan=enterprise',
      custom: true,
    }),
  ];

  return (
    <section id="pricing" className="scroll-mt-20 hairline-y border-y bg-sunken">
      <div className="mx-auto max-w-6xl px-5 py-24">
        <SectionHead
          eyebrow={t('lp.price.eyebrow')}
          title={t('lp.price.title')}
          subtitle={t('lp.price.sub')}
        />
        <div className="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
          {plans.map((p) => (
            <div
              key={p.name}
              className={`relative flex flex-col rounded-[18px] p-6 ${
                p.highlight
                  ? 'bg-surface shadow-e3 ring-2 ring-[rgb(var(--brand))]'
                  : 'bg-surface shadow-e1 hairline'
              }`}
            >
              {p.highlight && (
                <span className="absolute -top-3 left-6 rounded-full bg-brand px-3 py-1 text-[11.5px] font-semibold text-white">
                  {t('lp.price.mostChosen')}
                </span>
              )}
              <h3 className="text-[15px] font-semibold text-ink">{p.name}</h3>
              <div className="mt-3 flex items-baseline gap-1.5">
                <span className="text-[32px] leading-none font-semibold tracking-[-0.03em] text-ink">
                  {p.price}
                </span>
                <span className="text-[13px] text-ink-3">{p.note}</span>
              </div>
              <div className="mt-3 min-h-[42px]">
                <div className="text-[13px] font-medium text-ink">{p.allowance}</div>
                {p.meta && <div className="mt-0.5 text-[11.5px] text-ink-3">{p.meta}</div>}
              </div>
              <p className="mt-2 min-h-[54px] text-[13px] leading-relaxed text-ink-2">{p.blurb}</p>
              <ul className="mt-4 flex-1 space-y-2.5">
                {p.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-[13px] text-ink-2">
                    <IconCheck size={15} className="mt-0.5 shrink-0 text-success" />
                    {f}
                  </li>
                ))}
              </ul>
              <LinkButton
                href={p.href}
                variant={p.highlight ? 'primary' : 'secondary'}
                size="md"
                full
                className="mt-6"
              >
                {p.cta}
              </LinkButton>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ═══ security ══════════════════════════════════════════════════ */

function Security({ t }: { t: Translate }) {
  const items = [
    { icon: <IconLock size={17} />, title: t('lp.sec.i1t'), desc: t('lp.sec.i1d') },
    { icon: <IconShield size={17} />, title: t('lp.sec.i2t'), desc: t('lp.sec.i2d') },
    { icon: <IconDatabase size={17} />, title: t('lp.sec.i3t'), desc: t('lp.sec.i3d') },
    { icon: <IconBook size={17} />, title: t('lp.sec.i4t'), desc: t('lp.sec.i4d') },
  ];
  return (
    <section className="mx-auto max-w-6xl px-5 py-24">
      <SectionHead eyebrow={t('lp.sec.eyebrow')} title={t('lp.sec.title')} subtitle={t('lp.sec.sub')} />
      <div className="mt-12 grid gap-6 sm:grid-cols-2">
        {items.map((i) => (
          <div key={i.title} className="flex gap-4 rounded-[14px] bg-surface p-5 shadow-e1 hairline">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-surface-3 text-ink-2">
              {i.icon}
            </div>
            <div>
              <h3 className="text-[14.5px] font-semibold text-ink">{i.title}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{i.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ═══ cta + footer ══════════════════════════════════════════════ */

function FinalCta({ t }: { t: Translate }) {
  return (
    <section className="relative overflow-hidden hairline-t border-t">
      <div className="pointer-events-none absolute inset-0 aurora opacity-80" />
      <div className="relative mx-auto max-w-3xl px-5 py-24 text-center">
        <Logo size={44} className="mx-auto" />
        <h2 className="mt-7 text-[36px] leading-[1.1] font-semibold tracking-[-0.032em] text-ink text-balance-pretty sm:text-[42px]">
          {t('lp.cta.title1')}
          <br />
          {t('lp.cta.title2')}
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-[16px] leading-relaxed text-ink-2">{t('lp.cta.sub')}</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <LinkButton href="/signup" variant="primary" size="lg" iconRight={<IconArrowRight size={16} />}>
            {t('lp.cta.create')}
          </LinkButton>
          <LinkButton href="/login" variant="secondary" size="lg">
            {t('lp.nav.signin')}
          </LinkButton>
        </div>
      </div>
    </section>
  );
}

function Footer({ t }: { t: Translate }) {
  return (
    <footer className="hairline-t border-t bg-sunken">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Wordmark />
          <span className="text-[12.5px] text-ink-3">{t('lp.footer.tagline')}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[12.5px] text-ink-3">
          <a href="#how" className="transition-colors hover:text-ink">{t('lp.nav.how')}</a>
          <a href="#pricing" className="transition-colors hover:text-ink">{t('lp.nav.pricing')}</a>
          <Link href="/login" className="transition-colors hover:text-ink">{t('lp.nav.signin')}</Link>
          <span>© {new Date().getFullYear()} Ovoz</span>
        </div>
      </div>
    </footer>
  );
}

/* ═══ shared ════════════════════════════════════════════════════ */

function SectionHead({
  eyebrow,
  title,
  subtitle,
  align = 'center',
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  align?: 'center' | 'left';
}) {
  return (
    <div className={align === 'center' ? 'mx-auto max-w-2xl text-center' : 'max-w-xl'}>
      <div className="text-[12.5px] font-semibold tracking-wide text-brand uppercase">{eyebrow}</div>
      <h2 className="mt-3 text-[30px] leading-[1.15] font-semibold tracking-[-0.03em] text-ink text-balance-pretty sm:text-[36px]">
        {title}
      </h2>
      {subtitle && (
        <p className="mt-4 text-[15.5px] leading-relaxed text-ink-2 text-balance-pretty">{subtitle}</p>
      )}
    </div>
  );
}
