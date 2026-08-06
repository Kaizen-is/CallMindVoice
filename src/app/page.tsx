import Link from 'next/link';
import { CallDemo } from '@/components/marketing/call-demo';
import { RoiCalculator } from '@/components/marketing/roi-calculator';
import { ThemeToggle } from '@/components/theme-toggle';
import { LinkButton } from '@/components/ui/primitives';
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

export default async function LandingPage() {
  const session = await currentSession();

  return (
    <div className="relative">
      <Nav signedIn={Boolean(session)} />
      <Hero signedIn={Boolean(session)} />
      <Problem />
      <HowItWorks />
      <Languages />
      <Features />
      <Latency />
      <Roi />
      <Pricing />
      <Security />
      <FinalCta />
      <Footer />
    </div>
  );
}

/* ═══ nav ═══════════════════════════════════════════════════════ */

function Nav({ signedIn }: { signedIn: boolean }) {
  return (
    <header className="sticky top-0 z-50 w-full glass hairline-b">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-5">
        <Link href="/" className="shrink-0">
          <Wordmark />
        </Link>
        <nav className="hidden items-center gap-1 md:flex">
          {[
            ['How it works', '#how'],
            ['Languages', '#languages'],
            ['Platform', '#features'],
            ['ROI', '#roi'],
            ['Pricing', '#pricing'],
          ].map(([label, href]) => (
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
          <ThemeToggle />
          {signedIn ? (
            <LinkButton href="/app" variant="primary" size="sm" iconRight={<IconArrowRight size={14} />}>
              Open console
            </LinkButton>
          ) : (
            <>
              <LinkButton href="/login" variant="ghost" size="sm" className="hidden sm:inline-flex">
                Sign in
              </LinkButton>
              <LinkButton href="/signup" variant="primary" size="sm">
                Start free
              </LinkButton>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

/* ═══ hero ══════════════════════════════════════════════════════ */

function Hero({ signedIn }: { signedIn: boolean }) {
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
              Built for Uzbek, Russian and English callers
            </div>

            <h1
              className="animate-fade-up mt-6 text-[42px] leading-[1.04] font-semibold tracking-[-0.035em] text-balance-pretty sm:text-[56px]"
              style={{ animationDelay: '60ms' }}
            >
              Your documents,
              <br />
              <span className="brand-gradient-text">answering your phones.</span>
            </h1>

            <p
              className="animate-fade-up mt-6 max-w-xl text-[17px] leading-relaxed text-ink-2 text-balance-pretty"
              style={{ animationDelay: '120ms' }}
            >
              Upload a price list, an FAQ, a policy PDF. Ovoz turns them into a voice agent that
              picks up in under a second, answers only what your documents actually say, and hands
              the hard calls to your team with the transcript already summarised.
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
                {signedIn ? 'Open your console' : 'Start free — 14 days'}
              </LinkButton>
              <LinkButton href="/login" variant="secondary" size="lg" icon={<IconPhone size={16} />}>
                See a live call
              </LinkButton>
            </div>

            <div
              className="animate-fade-up mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-ink-3"
              style={{ animationDelay: '240ms' }}
            >
              {['No credit card', 'Live in an afternoon', 'Your data stays yours'].map((t) => (
                <span key={t} className="inline-flex items-center gap-1.5">
                  <IconCheck size={14} className="text-success" />
                  {t}
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

function Problem() {
  const stats = [
    { value: '~$500', label: 'Monthly cost of one contact-centre seat in Tashkent' },
    { value: '70–90%', label: 'Of inbound calls are the same dozen questions' },
    { value: '<1 sec', label: 'Before a caller starts to feel ignored' },
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

function HowItWorks() {
  const steps = [
    {
      icon: <IconUpload size={19} />,
      title: 'Upload what you already have',
      body: 'PDFs, Word files, spreadsheets, your website. No rewriting into a bot builder, no decision trees, no scripts to maintain.',
    },
    {
      icon: <IconDatabase size={19} />,
      title: 'We build the knowledge index',
      body: 'Documents are split along their own structure, embedded, and indexed so the agent can find the one paragraph that answers a question — and cite it.',
    },
    {
      icon: <IconPhone size={19} />,
      title: 'Point a number at it',
      body: 'Connect a SIP trunk or a Twilio number. The agent picks up, answers in the caller’s language, and escalates the moment it is unsure.',
    },
  ];

  return (
    <section id="how" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-24">
      <SectionHead
        eyebrow="How it works"
        title="Three steps, not a three-month project"
        subtitle="The whole point is that you already wrote the answers. We just make them answerable over the phone."
      />
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

function Languages() {
  return (
    <section id="languages" className="scroll-mt-20 hairline-y border-y bg-sunken">
      <div className="mx-auto max-w-6xl px-5 py-24">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <SectionHead
              align="left"
              eyebrow="Built here, not localised later"
              title="Uzbek is a first-class language, not a checkbox"
              subtitle="Uzbek is written in two alphabets and spoken alongside Russian in the same sentence. Global platforms treat that as an edge case. For us it is the default case."
            />
            <ul className="mt-8 space-y-4">
              {[
                {
                  t: 'Latin and Cyrillic collapse to one index',
                  d: '«шифокор» and “shifokor” retrieve the same paragraph, whichever way your documents were typed.',
                },
                {
                  t: 'Code-switching mid-sentence is expected',
                  d: 'A caller who starts in Uzbek and slips into Russian gets an answer in the language they landed on.',
                },
                {
                  t: 'Morphology-tolerant matching',
                  d: '“shifokorga”, “shifokorlar”, “врачу” — all resolve to the same concept without you tagging synonyms.',
                },
              ].map((f) => (
                <li key={f.t} className="flex gap-3">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
                    <IconCheck size={12} strokeWidth={3} />
                  </span>
                  <div>
                    <div className="text-[14px] font-medium text-ink">{f.t}</div>
                    <p className="mt-0.5 text-[13px] leading-relaxed text-ink-3">{f.d}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="grid gap-4">
            {[
              { flag: <FlagUZ size={26} />, name: 'O‘zbekcha', sample: 'Kardiolog qabuli qancha turadi?', reply: 'Kardiolog qabuli 180 000 so‘m.' },
              { flag: <FlagRU size={26} />, name: 'Русский', sample: 'Вы принимаете страховой полис?', reply: 'Да, мы работаем с четырьмя страховыми.' },
              { flag: <FlagEN size={26} />, name: 'English', sample: 'What time do you close on Saturdays?', reply: 'Saturdays we are open 10 until 3.' },
            ].map((l) => (
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

function Features() {
  const features = [
    {
      icon: <IconShield size={18} />,
      title: 'It says no when it should',
      body: 'Every answer carries a confidence score built from retrieval coverage, margin and lexical strength. Below your threshold, the caller gets a human instead of a confident guess.',
    },
    {
      icon: <IconHeadset size={18} />,
      title: 'Hand-off with the context attached',
      body: 'Your operator picks up to a summary of what the caller wants, the full transcript, and the exact passages the AI was reading. No “can you repeat that from the beginning”.',
    },
    {
      icon: <IconBook size={18} />,
      title: 'Every answer is traceable',
      body: 'Open any call and see which document and which paragraph produced each sentence. When an answer is wrong, you know exactly which file to fix.',
    },
    {
      icon: <IconChart size={18} />,
      title: 'The questions you cannot answer',
      body: 'Unanswered questions are collected and ranked by frequency, so improving the agent is a to-do list rather than a guessing game.',
    },
    {
      icon: <IconGlobe size={18} />,
      title: 'Any telephony you already run',
      body: 'Twilio Elastic SIP, a local carrier trunk, or your existing PBX. Numbers, routing and business hours are configured in the console.',
    },
    {
      icon: <IconCode size={18} />,
      title: 'An API under everything',
      body: 'Keys, webhooks and a documented REST surface, so the agent can sit inside the CRM your team already lives in.',
    },
  ];

  return (
    <section id="features" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-24">
      <SectionHead
        eyebrow="Platform"
        title="The parts that decide whether it survives contact with real callers"
        subtitle="Anyone can demo a voice bot answering a scripted question. These are the things that matter on call four hundred."
      />
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

function Latency() {
  const budget = [
    { label: 'Speech recognition', ms: 180, tone: 'bg-brand' },
    { label: 'Knowledge retrieval', ms: 45, tone: 'bg-violet' },
    { label: 'Answer generation', ms: 240, tone: 'bg-teal' },
    { label: 'Speech synthesis', ms: 120, tone: 'bg-success' },
  ];
  const total = budget.reduce((a, b) => a + b.ms, 0);

  return (
    <section className="hairline-y border-y bg-sunken">
      <div className="mx-auto max-w-6xl px-5 py-24">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <SectionHead
              align="left"
              eyebrow="Latency budget"
              title="Under a second, or it feels broken"
              subtitle="A pause longer than a second reads as a dropped call. Every stage of the pipeline is measured on every turn, and the number is on your dashboard — not in a brochure."
            />
            <div className="mt-8 rounded-[14px] bg-surface p-5 shadow-e1 hairline">
              <div className="flex items-baseline justify-between">
                <span className="text-[12.5px] font-medium text-ink-2">Target budget</span>
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
              <h3 className="text-[15.5px] font-semibold text-ink">How the pipeline is arranged</h3>
            </div>
            <ol className="space-y-4">
              {[
                'Audio streams in continuously — recognition runs on partial speech rather than waiting for silence.',
                'Retrieval fuses a lexical BM25 pass with dense vectors, so exact terms like a policy number and paraphrased questions both land.',
                'Generation is constrained to the retrieved passages and capped for spoken length; it never free-associates.',
                'Speech synthesis starts on the first clause rather than the finished sentence.',
              ].map((step, i) => (
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

function Roi() {
  return (
    <section id="roi" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-24">
      <SectionHead
        eyebrow="The business case"
        title="Work out whether this is worth it"
        subtitle="Move the sliders to your own numbers. If the answer comes out negative, we would rather you found out here."
      />
      <div className="mt-12 rounded-[20px] bg-surface p-7 shadow-e2 hairline sm:p-9">
        <RoiCalculator />
      </div>
    </section>
  );
}

/* ═══ pricing ═══════════════════════════════════════════════════ */

function Pricing() {
  const plans = [
    {
      name: 'Start',
      price: '$490',
      note: 'per month',
      blurb: 'One number, one agent — for a single clinic, salon or branch.',
      features: ['Up to 1 000 calls / month', '1 phone number', '3 team seats', '500 MB knowledge base', 'Email support'],
      cta: 'Start free trial',
      highlight: false,
    },
    {
      name: 'Pro',
      price: '$1 890',
      note: 'per month',
      blurb: 'Multi-branch operations with a real operator team behind the AI.',
      features: [
        'Up to 10 000 calls / month',
        '5 phone numbers',
        'Unlimited seats',
        'Operator workspace & routing',
        'API access and webhooks',
        'Priority support',
      ],
      cta: 'Start free trial',
      highlight: true,
    },
    {
      name: 'Enterprise',
      price: 'Custom',
      note: 'annual contract',
      blurb: 'Banks, insurers and state operators with residency requirements.',
      features: [
        'Unlimited call volume',
        'On-premise or private cloud',
        'Data stays inside Uzbekistan',
        'SSO, audit export, SLA 99.9%',
        'Dedicated integration engineer',
      ],
      cta: 'Talk to us',
      highlight: false,
    },
  ];

  return (
    <section id="pricing" className="scroll-mt-20 hairline-y border-y bg-sunken">
      <div className="mx-auto max-w-6xl px-5 py-24">
        <SectionHead
          eyebrow="Pricing"
          title="Priced against an operator’s salary, not a Silicon Valley budget"
          subtitle="Usage is billed at $0.065 per minute on top of the plan. No per-seat tax on the people you keep."
        />
        <div className="mt-14 grid gap-6 lg:grid-cols-3">
          {plans.map((p) => (
            <div
              key={p.name}
              className={`relative flex flex-col rounded-[18px] p-7 ${
                p.highlight
                  ? 'bg-surface shadow-e3 ring-2 ring-[rgb(var(--brand))]'
                  : 'bg-surface shadow-e1 hairline'
              }`}
            >
              {p.highlight && (
                <span className="absolute -top-3 left-7 rounded-full bg-brand px-3 py-1 text-[11.5px] font-semibold text-white">
                  Most chosen
                </span>
              )}
              <h3 className="text-[15px] font-semibold text-ink">{p.name}</h3>
              <div className="mt-3 flex items-baseline gap-1.5">
                <span className="text-[34px] leading-none font-semibold tracking-[-0.03em] text-ink">
                  {p.price}
                </span>
                <span className="text-[13px] text-ink-3">{p.note}</span>
              </div>
              <p className="mt-3 min-h-[40px] text-[13.5px] leading-relaxed text-ink-2">{p.blurb}</p>
              <ul className="mt-6 flex-1 space-y-2.5">
                {p.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-[13.5px] text-ink-2">
                    <IconCheck size={15} className="mt-0.5 shrink-0 text-success" />
                    {f}
                  </li>
                ))}
              </ul>
              <LinkButton
                href={p.name === 'Enterprise' ? '/signup?plan=enterprise' : '/signup'}
                variant={p.highlight ? 'primary' : 'secondary'}
                size="md"
                full
                className="mt-7"
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

function Security() {
  const items = [
    { icon: <IconLock size={17} />, t: 'Encrypted in transit and at rest', d: 'TLS 1.2+ everywhere, AES-256 for stored transcripts and documents.' },
    { icon: <IconShield size={17} />, t: 'Hard tenant isolation', d: 'Every query is scoped to your tenant at the data layer. One company can never read another’s index.' },
    { icon: <IconDatabase size={17} />, t: 'Residency on request', d: 'Enterprise deployments run inside Uzbekistan, on-premise or in a private cloud you control.' },
    { icon: <IconBook size={17} />, t: 'Retention you set', d: 'Recordings, transcripts and documents follow your policy, with an audit log of who changed what.' },
  ];
  return (
    <section className="mx-auto max-w-6xl px-5 py-24">
      <SectionHead
        eyebrow="Trust"
        title="Built for the industries that ask the hard questions first"
        subtitle="Clinics and insurers hold data they cannot afford to be careless with. So the boring parts are not optional."
      />
      <div className="mt-12 grid gap-6 sm:grid-cols-2">
        {items.map((i) => (
          <div key={i.t} className="flex gap-4 rounded-[14px] bg-surface p-5 shadow-e1 hairline">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-surface-3 text-ink-2">
              {i.icon}
            </div>
            <div>
              <h3 className="text-[14.5px] font-semibold text-ink">{i.t}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{i.d}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ═══ cta + footer ══════════════════════════════════════════════ */

function FinalCta() {
  return (
    <section className="relative overflow-hidden hairline-t border-t">
      <div className="pointer-events-none absolute inset-0 aurora opacity-80" />
      <div className="relative mx-auto max-w-3xl px-5 py-24 text-center">
        <Logo size={44} className="mx-auto" />
        <h2 className="mt-7 text-[36px] leading-[1.1] font-semibold tracking-[-0.032em] text-ink text-balance-pretty sm:text-[42px]">
          Upload one document.
          <br />
          Hear it answer the phone.
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-[16px] leading-relaxed text-ink-2">
          Fourteen days, no card, no sales call. If it cannot answer your callers’ questions, you
          will know within the hour.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <LinkButton href="/signup" variant="primary" size="lg" iconRight={<IconArrowRight size={16} />}>
            Create your agent
          </LinkButton>
          <LinkButton href="/login" variant="secondary" size="lg">
            Sign in
          </LinkButton>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="hairline-t border-t bg-sunken">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Wordmark />
          <span className="text-[12.5px] text-ink-3">AI Customer Service Platform</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[12.5px] text-ink-3">
          <a href="#how" className="transition-colors hover:text-ink">How it works</a>
          <a href="#pricing" className="transition-colors hover:text-ink">Pricing</a>
          <Link href="/login" className="transition-colors hover:text-ink">Sign in</Link>
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
