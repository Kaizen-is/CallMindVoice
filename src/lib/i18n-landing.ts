import type { UiLocale } from './types';

/**
 * Landing-page copy, kept out of the console dictionary in `i18n.ts` because it
 * is a different register (marketing) and a large block. Merged into `DICTS`
 * there so `translator(locale)` resolves these keys with the same
 * `uz-Cyrl → uz → en` fallback chain as the rest of the app.
 *
 * Russian and Uzbek strings are a first careful pass — have a native speaker
 * review before the copy is considered final. Brand/units (Ovoz, FAQ, PDF, SIP,
 * Twilio, BM25, API, ms, MB, TLS, AES, SLA, SSO) are intentionally left as-is.
 */
type Dict = Record<string, string>;

const en: Dict = {
  'lp.nav.how': 'How it works',
  'lp.nav.languages': 'Languages',
  'lp.nav.platform': 'Platform',
  'lp.nav.roi': 'ROI',
  'lp.nav.pricing': 'Pricing',
  'lp.nav.signin': 'Sign in',
  'lp.nav.startFree': 'Start free',
  'lp.nav.openConsole': 'Open console',

  'lp.hero.badge': 'Built for Uzbek, Russian and English callers',
  'lp.hero.title1': 'Your documents,',
  'lp.hero.title2': 'answering your phones.',
  'lp.hero.sub':
    'Upload a price list, an FAQ, a policy PDF. Ovoz turns them into a voice agent that picks up in under a second, answers only what your documents actually say, and hands the hard calls to your team with the transcript already summarised.',
  'lp.hero.ctaConsole': 'Open your console',
  'lp.hero.ctaStart': 'Start free — 14 days',
  'lp.hero.ctaDemo': 'See a live call',
  'lp.hero.trust1': 'No credit card',
  'lp.hero.trust2': 'Live in an afternoon',
  'lp.hero.trust3': 'Your data stays yours',

  'lp.problem.stat1': 'Monthly cost of one contact-centre seat in Tashkent',
  'lp.problem.stat2': 'Of inbound calls are the same dozen questions',
  'lp.problem.stat3': 'Before a caller starts to feel ignored',

  'lp.how.eyebrow': 'How it works',
  'lp.how.title': 'Three steps, not a three-month project',
  'lp.how.sub':
    'The whole point is that you already wrote the answers. We just make them answerable over the phone.',
  'lp.how.s1t': 'Upload what you already have',
  'lp.how.s1b':
    'PDFs, Word files, spreadsheets, your website. No rewriting into a bot builder, no decision trees, no scripts to maintain.',
  'lp.how.s2t': 'We build the knowledge index',
  'lp.how.s2b':
    'Documents are split along their own structure, embedded, and indexed so the agent can find the one paragraph that answers a question — and cite it.',
  'lp.how.s3t': 'Point a number at it',
  'lp.how.s3b':
    'Connect a SIP trunk or a Twilio number. The agent picks up, answers in the caller’s language, and escalates the moment it is unsure.',

  'lp.lang.eyebrow': 'Built here, not localised later',
  'lp.lang.title': 'Uzbek is a first-class language, not a checkbox',
  'lp.lang.sub':
    'Uzbek is written in two alphabets and spoken alongside Russian in the same sentence. Global platforms treat that as an edge case. For us it is the default case.',
  'lp.lang.f1t': 'Latin and Cyrillic collapse to one index',
  'lp.lang.f1d':
    '«шифокор» and “shifokor” retrieve the same paragraph, whichever way your documents were typed.',
  'lp.lang.f2t': 'Code-switching mid-sentence is expected',
  'lp.lang.f2d':
    'A caller who starts in Uzbek and slips into Russian gets an answer in the language they landed on.',
  'lp.lang.f3t': 'Morphology-tolerant matching',
  'lp.lang.f3d':
    '“shifokorga”, “shifokorlar”, “врачу” — all resolve to the same concept without you tagging synonyms.',

  'lp.feat.eyebrow': 'Platform',
  'lp.feat.title': 'The parts that decide whether it survives contact with real callers',
  'lp.feat.sub':
    'Anyone can demo a voice bot answering a scripted question. These are the things that matter on call four hundred.',
  'lp.feat.f1t': 'It says no when it should',
  'lp.feat.f1b':
    'Every answer carries a confidence score built from retrieval coverage, margin and lexical strength. Below your threshold, the caller gets a human instead of a confident guess.',
  'lp.feat.f2t': 'Hand-off with the context attached',
  'lp.feat.f2b':
    'Your operator picks up to a summary of what the caller wants, the full transcript, and the exact passages the AI was reading. No “can you repeat that from the beginning”.',
  'lp.feat.f3t': 'Every answer is traceable',
  'lp.feat.f3b':
    'Open any call and see which document and which paragraph produced each sentence. When an answer is wrong, you know exactly which file to fix.',
  'lp.feat.f4t': 'The questions you cannot answer',
  'lp.feat.f4b':
    'Unanswered questions are collected and ranked by frequency, so improving the agent is a to-do list rather than a guessing game.',
  'lp.feat.f5t': 'Any telephony you already run',
  'lp.feat.f5b':
    'Twilio Elastic SIP, a local carrier trunk, or your existing PBX. Numbers, routing and business hours are configured in the console.',
  'lp.feat.f6t': 'An API under everything',
  'lp.feat.f6b':
    'Keys, webhooks and a documented REST surface, so the agent can sit inside the CRM your team already lives in.',

  'lp.lat.eyebrow': 'Latency budget',
  'lp.lat.title': 'Under a second, or it feels broken',
  'lp.lat.sub':
    'A pause longer than a second reads as a dropped call. Every stage of the pipeline is measured on every turn, and the number is on your dashboard — not in a brochure.',
  'lp.lat.b1': 'Speech recognition',
  'lp.lat.b2': 'Knowledge retrieval',
  'lp.lat.b3': 'Answer generation',
  'lp.lat.b4': 'Speech synthesis',
  'lp.lat.target': 'Target budget',
  'lp.lat.arranged': 'How the pipeline is arranged',
  'lp.lat.step1':
    'Audio streams in continuously — recognition runs on partial speech rather than waiting for silence.',
  'lp.lat.step2':
    'Retrieval fuses a lexical BM25 pass with dense vectors, so exact terms like a policy number and paraphrased questions both land.',
  'lp.lat.step3':
    'Generation is constrained to the retrieved passages and capped for spoken length; it never free-associates.',
  'lp.lat.step4': 'Speech synthesis starts on the first clause rather than the finished sentence.',

  'lp.roi.eyebrow': 'The business case',
  'lp.roi.title': 'Work out whether this is worth it',
  'lp.roi.sub':
    'Move the sliders to your own numbers. If the answer comes out negative, we would rather you found out here.',

  'lp.roicalc.calls': 'Calls per month',
  'lp.roicalc.avg': 'Average call length',
  'lp.roicalc.min': 'min',
  'lp.roicalc.salary': 'Fully-loaded cost per operator',
  'lp.roicalc.perMonth': '/ month',
  'lp.roicalc.deflection': 'Share the AI resolves without a human',
  'lp.roicalc.assumes':
    'Assumes 65% operator occupancy over a 22-day month. Ovoz bills only the minutes beyond your plan’s included bundle, and puts you on the cheapest plan for that volume.',
  'lp.roicalc.opNeeded': 'Operators needed today',
  'lp.roicalc.curCost': 'Current monthly cost',
  'lp.roicalc.opStill': 'Operators still needed',
  'lp.roicalc.ovozCost': 'Ovoz platform + usage',
  'lp.roicalc.newCost': 'New monthly cost',
  'lp.roicalc.saving': 'Monthly saving',
  'lp.roicalc.lowerYear': '{pct} lower than running this on people alone · {year} a year',
  'lp.roicalc.negative':
    'At this volume a human team is still cheaper — talk to us anyway, we will tell you so.',

  'lp.price.eyebrow': 'Pricing',
  'lp.price.title': 'Priced against an operator’s salary, not a Silicon Valley budget',
  'lp.price.sub':
    'Usage is billed at $0.04 per minute after your plan’s included minutes. No per-seat tax on the people you keep.',
  'lp.price.mostChosen': 'Most chosen',
  'lp.price.perMonth': 'per month',
  'lp.price.annual': 'annual contract',
  'lp.price.p1blurb': 'One number, one agent — for a single clinic, salon or branch.',
  'lp.price.p1f1': 'Up to 1 000 calls / month',
  'lp.price.p1f2': '1 phone number',
  'lp.price.p1f3': '3 team seats',
  'lp.price.p1f4': '500 MB knowledge base',
  'lp.price.p1f5': 'Email support',
  'lp.price.p2blurb': 'Multi-branch operations with a real operator team behind the AI.',
  'lp.price.p2f1': 'Up to 10 000 calls / month',
  'lp.price.p2f2': '5 phone numbers',
  'lp.price.p2f3': 'Unlimited seats',
  'lp.price.p2f4': 'Operator workspace & routing',
  'lp.price.p2f5': 'API access and webhooks',
  'lp.price.p2f6': 'Priority support',
  'lp.price.p3blurb': 'Banks, insurers and state operators with residency requirements.',
  'lp.price.p3f1': 'Unlimited call volume',
  'lp.price.p3f2': 'On-premise or private cloud',
  'lp.price.p3f3': 'Data stays inside Uzbekistan',
  'lp.price.p3f4': 'SSO, audit export, SLA 99.9%',
  'lp.price.p3f5': 'Dedicated integration engineer',
  'lp.price.ctaTrial': 'Start free trial',
  'lp.price.ctaTalk': 'Talk to us',
  'lp.price.custom': 'Custom',
  'lp.price.callsUnit': 'calls',
  'lp.price.over': 'then',
  'lp.price.paygMetered': 'Billed per minute — no bundle',
  'lp.price.p0blurb': 'No monthly fee. Pay only for the minutes you use, and switch to a plan when it works out cheaper.',
  'lp.price.p0f2': 'No monthly commitment',
  'lp.price.p0f3': 'Upgrade to a plan anytime',

  'lp.sec.eyebrow': 'Trust',
  'lp.sec.title': 'Built for the industries that ask the hard questions first',
  'lp.sec.sub':
    'Clinics and insurers hold data they cannot afford to be careless with. So the boring parts are not optional.',
  'lp.sec.i1t': 'Encrypted in transit and at rest',
  'lp.sec.i1d': 'TLS 1.2+ everywhere, AES-256 for stored transcripts and documents.',
  'lp.sec.i2t': 'Hard tenant isolation',
  'lp.sec.i2d':
    'Every query is scoped to your tenant at the data layer. One company can never read another’s index.',
  'lp.sec.i3t': 'Residency on request',
  'lp.sec.i3d':
    'Enterprise deployments run inside Uzbekistan, on-premise or in a private cloud you control.',
  'lp.sec.i4t': 'Retention you set',
  'lp.sec.i4d':
    'Recordings, transcripts and documents follow your policy, with an audit log of who changed what.',

  'lp.cta.title1': 'Upload one document.',
  'lp.cta.title2': 'Hear it answer the phone.',
  'lp.cta.sub':
    'Fourteen days, no card, no sales call. If it cannot answer your callers’ questions, you will know within the hour.',
  'lp.cta.create': 'Create your agent',

  'lp.footer.tagline': 'AI Customer Service Platform',
};

const ru: Dict = {
  'lp.nav.how': 'Как это работает',
  'lp.nav.languages': 'Языки',
  'lp.nav.platform': 'Платформа',
  'lp.nav.roi': 'Выгода',
  'lp.nav.pricing': 'Тарифы',
  'lp.nav.signin': 'Войти',
  'lp.nav.startFree': 'Начать бесплатно',
  'lp.nav.openConsole': 'Открыть консоль',

  'lp.hero.badge': 'Создано для звонков на узбекском, русском и английском',
  'lp.hero.title1': 'Ваши документы',
  'lp.hero.title2': 'отвечают на ваши звонки.',
  'lp.hero.sub':
    'Загрузите прайс-лист, FAQ или PDF с правилами. Ovoz превращает их в голосового агента, который поднимает трубку меньше чем за секунду, отвечает только то, что действительно написано в ваших документах, и передаёт сложные звонки вашей команде — с уже готовым кратким пересказом разговора.',
  'lp.hero.ctaConsole': 'Открыть консоль',
  'lp.hero.ctaStart': 'Начать бесплатно — 14 дней',
  'lp.hero.ctaDemo': 'Посмотреть живой звонок',
  'lp.hero.trust1': 'Без карты',
  'lp.hero.trust2': 'Запуск за полдня',
  'lp.hero.trust3': 'Ваши данные остаются вашими',

  'lp.problem.stat1': 'Ежемесячная стоимость одного места в контакт-центре в Ташкенте',
  'lp.problem.stat2': 'Входящих звонков — это одни и те же с десяток вопросов',
  'lp.problem.stat3': 'Прежде чем звонящий почувствует, что его игнорируют',

  'lp.how.eyebrow': 'Как это работает',
  'lp.how.title': 'Три шага, а не трёхмесячный проект',
  'lp.how.sub':
    'Смысл в том, что ответы вы уже написали. Мы просто делаем их доступными по телефону.',
  'lp.how.s1t': 'Загрузите то, что у вас уже есть',
  'lp.how.s1b':
    'PDF, файлы Word, таблицы, ваш сайт. Не нужно переписывать всё в конструкторе ботов, никаких деревьев решений и скриптов для поддержки.',
  'lp.how.s2t': 'Мы строим индекс знаний',
  'lp.how.s2b':
    'Документы разбиваются по их собственной структуре, векторизуются и индексируются, чтобы агент нашёл именно тот абзац, который отвечает на вопрос, — и сослался на него.',
  'lp.how.s3t': 'Направьте на него номер',
  'lp.how.s3b':
    'Подключите SIP-транк или номер Twilio. Агент поднимает трубку, отвечает на языке звонящего и передаёт разговор человеку, как только не уверен.',

  'lp.lang.eyebrow': 'Сделано здесь, а не локализовано потом',
  'lp.lang.title': 'Узбекский — полноценный язык, а не галочка',
  'lp.lang.sub':
    'Узбекский пишут в двух алфавитах и говорят на нём вперемешку с русским в одном предложении. Глобальные платформы считают это исключением. Для нас это норма.',
  'lp.lang.f1t': 'Латиница и кириллица сходятся в один индекс',
  'lp.lang.f1d':
    '«шифокор» и “shifokor” находят один и тот же абзац, как бы ни были набраны ваши документы.',
  'lp.lang.f2t': 'Переключение языка посреди фразы — это норма',
  'lp.lang.f2d':
    'Звонящий, который начал по-узбекски и перешёл на русский, получает ответ на том языке, на котором остановился.',
  'lp.lang.f3t': 'Устойчивость к морфологии',
  'lp.lang.f3d':
    '«shifokorga», «shifokorlar», «врачу» — всё сводится к одному понятию, и вам не нужно размечать синонимы.',

  'lp.feat.eyebrow': 'Платформа',
  'lp.feat.title': 'То, что решает, выдержит ли он встречу с реальными звонящими',
  'lp.feat.sub':
    'Показать голосового бота на заранее заготовленном вопросе может каждый. А это то, что важно на четырёхсотом звонке.',
  'lp.feat.f1t': 'Он говорит «нет», когда должен',
  'lp.feat.f1b':
    'У каждого ответа есть оценка уверенности — из полноты поиска, отрыва и лексической силы. Ниже вашего порога звонящий получает человека, а не уверенную догадку.',
  'lp.feat.f2t': 'Передача с уже прикреплённым контекстом',
  'lp.feat.f2b':
    'Ваш оператор получает краткое изложение запроса, полную расшифровку и те самые фрагменты, которые читал ИИ. Никаких «повторите с самого начала».',
  'lp.feat.f3t': 'Каждый ответ прослеживается',
  'lp.feat.f3b':
    'Откройте любой звонок и увидите, какой документ и какой абзац породил каждую фразу. Если ответ неверен, вы точно знаете, какой файл исправить.',
  'lp.feat.f4t': 'Вопросы, на которые вы не можете ответить',
  'lp.feat.f4b':
    'Оставшиеся без ответа вопросы собираются и ранжируются по частоте, так что улучшение агента — это список задач, а не игра в угадайку.',
  'lp.feat.f5t': 'Любая телефония, что у вас уже есть',
  'lp.feat.f5b':
    'Twilio Elastic SIP, транк местного оператора или ваша нынешняя АТС. Номера, маршрутизация и часы работы настраиваются в консоли.',
  'lp.feat.f6t': 'API под всем этим',
  'lp.feat.f6b':
    'Ключи, вебхуки и документированный REST, чтобы агент жил внутри той CRM, где уже работает ваша команда.',

  'lp.lat.eyebrow': 'Бюджет задержки',
  'lp.lat.title': 'Меньше секунды — иначе кажется, что сломалось',
  'lp.lat.sub':
    'Пауза длиннее секунды воспринимается как сорванный звонок. Каждый этап конвейера измеряется на каждой реплике, и цифра — на вашем дашборде, а не в брошюре.',
  'lp.lat.b1': 'Распознавание речи',
  'lp.lat.b2': 'Поиск по знаниям',
  'lp.lat.b3': 'Генерация ответа',
  'lp.lat.b4': 'Синтез речи',
  'lp.lat.target': 'Целевой бюджет',
  'lp.lat.arranged': 'Как устроен конвейер',
  'lp.lat.step1':
    'Аудио поступает непрерывно — распознавание идёт по частичной речи, не дожидаясь тишины.',
  'lp.lat.step2':
    'Поиск объединяет лексический проход BM25 с плотными векторами, поэтому и точные термины вроде номера полиса, и перефразированные вопросы находятся.',
  'lp.lat.step3':
    'Генерация ограничена найденными фрагментами и лимитом длины для речи; она никогда не фантазирует.',
  'lp.lat.step4': 'Синтез речи начинается с первого сегмента, а не с готового предложения.',

  'lp.roi.eyebrow': 'Экономическое обоснование',
  'lp.roi.title': 'Посчитайте, стоит ли оно того',
  'lp.roi.sub':
    'Подвиньте ползунки под свои цифры. Если результат окажется отрицательным, лучше вы узнаете это здесь.',

  'lp.roicalc.calls': 'Звонков в месяц',
  'lp.roicalc.avg': 'Средняя длительность звонка',
  'lp.roicalc.min': 'мин',
  'lp.roicalc.salary': 'Полная стоимость одного оператора',
  'lp.roicalc.perMonth': '/ месяц',
  'lp.roicalc.deflection': 'Доля, которую ИИ решает без человека',
  'lp.roicalc.assumes':
    'Исходим из 65% занятости оператора за 22-дневный месяц. Ovoz тарифицирует только минуты сверх включённого пакета плана и подбирает самый дешёвый план под этот объём.',
  'lp.roicalc.opNeeded': 'Операторов нужно сейчас',
  'lp.roicalc.curCost': 'Текущая стоимость в месяц',
  'lp.roicalc.opStill': 'Операторов всё ещё нужно',
  'lp.roicalc.ovozCost': 'Ovoz: платформа + использование',
  'lp.roicalc.newCost': 'Новая стоимость в месяц',
  'lp.roicalc.saving': 'Экономия в месяц',
  'lp.roicalc.lowerYear': 'на {pct} меньше, чем силами одних людей · {year} в год',
  'lp.roicalc.negative':
    'При таком объёме команда людей всё ещё дешевле — напишите нам всё равно, мы так и скажем.',

  'lp.price.eyebrow': 'Тарифы',
  'lp.price.title': 'Цена — от зарплаты оператора, а не от бюджета Кремниевой долины',
  'lp.price.sub':
    'Использование тарифицируется по $0,04 за минуту сверх включённых минут плана. Никакого налога за каждого сотрудника, которого вы оставляете.',
  'lp.price.mostChosen': 'Выбирают чаще всего',
  'lp.price.perMonth': 'в месяц',
  'lp.price.annual': 'годовой договор',
  'lp.price.p1blurb': 'Один номер, один агент — для одной клиники, салона или филиала.',
  'lp.price.p1f1': 'До 1 000 звонков / месяц',
  'lp.price.p1f2': '1 номер телефона',
  'lp.price.p1f3': '3 места для команды',
  'lp.price.p1f4': 'База знаний 500 МБ',
  'lp.price.p1f5': 'Поддержка по почте',
  'lp.price.p2blurb': 'Сеть филиалов с настоящей командой операторов за ИИ.',
  'lp.price.p2f1': 'До 10 000 звонков / месяц',
  'lp.price.p2f2': '5 номеров телефонов',
  'lp.price.p2f3': 'Неограниченно мест',
  'lp.price.p2f4': 'Рабочее место оператора и маршрутизация',
  'lp.price.p2f5': 'Доступ к API и вебхуки',
  'lp.price.p2f6': 'Приоритетная поддержка',
  'lp.price.p3blurb': 'Банки, страховые и госоператоры с требованиями к резидентности.',
  'lp.price.p3f1': 'Неограниченный объём звонков',
  'lp.price.p3f2': 'On-premise или частное облако',
  'lp.price.p3f3': 'Данные остаются в Узбекистане',
  'lp.price.p3f4': 'SSO, экспорт аудита, SLA 99,9%',
  'lp.price.p3f5': 'Выделенный инженер по интеграции',
  'lp.price.ctaTrial': 'Начать бесплатный период',
  'lp.price.ctaTalk': 'Связаться с нами',
  'lp.price.custom': 'Индивидуально',
  'lp.price.callsUnit': 'звонков',
  'lp.price.over': 'далее',
  'lp.price.paygMetered': 'Оплата за минуту — без пакета',
  'lp.price.p0blurb': 'Без ежемесячной платы. Платите только за использованные минуты и переходите на план, когда так выгоднее.',
  'lp.price.p0f2': 'Без ежемесячных обязательств',
  'lp.price.p0f3': 'Переход на план в любой момент',

  'lp.sec.eyebrow': 'Доверие',
  'lp.sec.title': 'Создано для отраслей, которые первыми задают трудные вопросы',
  'lp.sec.sub':
    'Клиники и страховые хранят данные, с которыми нельзя обращаться беспечно. Поэтому скучные вещи здесь не опциональны.',
  'lp.sec.i1t': 'Шифрование при передаче и хранении',
  'lp.sec.i1d': 'TLS 1.2+ повсюду, AES-256 для хранимых расшифровок и документов.',
  'lp.sec.i2t': 'Жёсткая изоляция арендаторов',
  'lp.sec.i2d':
    'Каждый запрос ограничен вашим арендатором на уровне данных. Одна компания никогда не прочитает индекс другой.',
  'lp.sec.i3t': 'Резидентность по запросу',
  'lp.sec.i3d':
    'Корпоративные развёртывания работают внутри Узбекистана — on-premise или в частном облаке под вашим контролем.',
  'lp.sec.i4t': 'Сроки хранения на ваше усмотрение',
  'lp.sec.i4d':
    'Записи, расшифровки и документы следуют вашей политике, с журналом аудита — кто и что изменил.',

  'lp.cta.title1': 'Загрузите один документ.',
  'lp.cta.title2': 'Услышьте, как он отвечает на звонки.',
  'lp.cta.sub':
    'Четырнадцать дней, без карты, без звонка от продажников. Если он не сможет отвечать вашим клиентам, вы узнаете об этом в течение часа.',
  'lp.cta.create': 'Создать своего агента',

  'lp.footer.tagline': 'Платформа ИИ для клиентского сервиса',
};

const uz: Dict = {
  'lp.nav.how': 'Qanday ishlaydi',
  'lp.nav.languages': 'Tillar',
  'lp.nav.platform': 'Platforma',
  'lp.nav.roi': 'Foyda',
  'lp.nav.pricing': 'Narxlar',
  'lp.nav.signin': 'Kirish',
  'lp.nav.startFree': 'Bepul boshlash',
  'lp.nav.openConsole': 'Konsolni ochish',

  'lp.hero.badge': 'O‘zbek, rus va ingliz tilidagi qo‘ng‘iroqlar uchun',
  'lp.hero.title1': 'Hujjatlaringiz',
  'lp.hero.title2': 'telefoningizga javob beradi.',
  'lp.hero.sub':
    'Narxlar ro‘yxati, FAQ yoki qoidalar PDF‘ini yuklang. Ovoz ularni bir soniyadan kamroq vaqtda javob beradigan ovozli agentga aylantiradi: u faqat hujjatlaringizda yozilganini aytadi va murakkab qo‘ng‘iroqlarni tayyor suhbat xulosasi bilan jamoangizga uzatadi.',
  'lp.hero.ctaConsole': 'Konsolni ochish',
  'lp.hero.ctaStart': 'Bepul boshlash — 14 kun',
  'lp.hero.ctaDemo': 'Jonli qo‘ng‘iroqni ko‘rish',
  'lp.hero.trust1': 'Karta kerak emas',
  'lp.hero.trust2': 'Yarim kunda ishga tushadi',
  'lp.hero.trust3': 'Ma‘lumotlaringiz o‘zingizniki qoladi',

  'lp.problem.stat1': 'Toshkentda bitta kontakt-markaz o‘rnining oylik xarajati',
  'lp.problem.stat2': 'Kiruvchi qo‘ng‘iroqlar o‘sha bir necha o‘nlab savoldan iborat',
  'lp.problem.stat3': 'Qo‘ng‘iroq qiluvchi o‘zini e‘tiborsiz his qilgunicha',

  'lp.how.eyebrow': 'Qanday ishlaydi',
  'lp.how.title': 'Uch qadam, uch oylik loyiha emas',
  'lp.how.sub':
    'Gap shundaki, javoblarni siz allaqachon yozib qo‘ygansiz. Biz ularni telefon orqali javob beradigan qilib beramiz, xolos.',
  'lp.how.s1t': 'Bor narsangizni yuklang',
  'lp.how.s1b':
    'PDF, Word fayllar, jadvallar, veb-saytingiz. Bot konstruktoriga qayta yozish, qaror daraxtlari yoki qo‘llab-quvvatlab turiladigan skriptlar kerak emas.',
  'lp.how.s2t': 'Biz bilim indeksini quramiz',
  'lp.how.s2b':
    'Hujjatlar o‘z tuzilishi bo‘yicha bo‘linadi, vektorlanadi va indekslanadi — shunda agent savolga javob beradigan aynan bitta xatboshini topadi va unga havola qiladi.',
  'lp.how.s3t': 'Unga raqam ulang',
  'lp.how.s3b':
    'SIP-trank yoki Twilio raqamini ulang. Agent go‘shakni ko‘taradi, qo‘ng‘iroq qiluvchining tilida javob beradi va ishonchsiz bo‘lgan zahoti odamga uzatadi.',

  'lp.lang.eyebrow': 'Shu yerda qurilgan, keyin lokallashtirilmagan',
  'lp.lang.title': 'O‘zbek tili — to‘laqonli til, belgilanadigan katakcha emas',
  'lp.lang.sub':
    'O‘zbek tili ikki alifboda yoziladi va bitta gapda rus tili bilan aralash gapiriladi. Global platformalar buni istisno deb biladi. Biz uchun bu — odatiy holat.',
  'lp.lang.f1t': 'Lotin va kirill bitta indeksga jamlanadi',
  'lp.lang.f1d':
    '«шифокор» va “shifokor” hujjatlaringiz qanday terilgan bo‘lsa ham, bitta xatboshini topadi.',
  'lp.lang.f2t': 'Gap o‘rtasida tilni almashtirish — kutilgan hol',
  'lp.lang.f2d':
    'O‘zbekcha boshlab, rus tiliga o‘tgan qo‘ng‘iroq qiluvchi o‘zi to‘xtagan tilda javob oladi.',
  'lp.lang.f3t': 'Morfologiyaga chidamli moslashtirish',
  'lp.lang.f3d':
    '«shifokorga», «shifokorlar», «врачу» — hammasi bir tushunchaga keladi, sizga sinonim belgilash shart emas.',

  'lp.feat.eyebrow': 'Platforma',
  'lp.feat.title': 'Uning haqiqiy qo‘ng‘iroqlarga dosh berishini hal qiladigan qismlar',
  'lp.feat.sub':
    'Ssenariyli savolga javob beradigan ovozli botni har kim ko‘rsata oladi. Bular esa to‘rt yuzinchi qo‘ng‘iroqda ahamiyatli bo‘lgan narsalar.',
  'lp.feat.f1t': 'Kerak bo‘lganda “yo‘q” deydi',
  'lp.feat.f1b':
    'Har bir javobda ishonch bahosi bor — qidiruv qamrovi, farq va leksik kuchdan. Sizning chegarangizdan past bo‘lsa, qo‘ng‘iroq qiluvchi ishonchli taxmin emas, odamni oladi.',
  'lp.feat.f2t': 'Kontekst biriktirilgan holda uzatish',
  'lp.feat.f2b':
    'Operatoringiz qo‘ng‘iroq qiluvchi nima istayotganining xulosasi, to‘liq matn va AI o‘qigan aynan o‘sha parchalar bilan javobga chiqadi. “Boshidan qaytaring” degani yo‘q.',
  'lp.feat.f3t': 'Har bir javobni izlab bo‘ladi',
  'lp.feat.f3b':
    'Istalgan qo‘ng‘iroqni oching va qaysi hujjat, qaysi xatboshi har bir gapni bergani ko‘rinadi. Javob noto‘g‘ri bo‘lsa, qaysi faylni tuzatishni aniq bilasiz.',
  'lp.feat.f4t': 'Javob berolmagan savollaringiz',
  'lp.feat.f4b':
    'Javobsiz qolgan savollar yig‘ilib, chastotasi bo‘yicha tartiblanadi — shunda agentni yaxshilash taxmin o‘yini emas, vazifalar ro‘yxatiga aylanadi.',
  'lp.feat.f5t': 'Siz ishlatayotgan istalgan telefoniya',
  'lp.feat.f5b':
    'Twilio Elastic SIP, mahalliy operator tranki yoki mavjud ATSingiz. Raqamlar, marshrutlash va ish soatlari konsolda sozlanadi.',
  'lp.feat.f6t': 'Hammasining ostida API',
  'lp.feat.f6b':
    'Kalitlar, vebhuklar va hujjatlashtirilgan REST — shunda agent jamoangiz allaqachon ishlaydigan CRM ichida tura oladi.',

  'lp.lat.eyebrow': 'Kechikish byudjeti',
  'lp.lat.title': 'Bir soniyadan kam, aks holda buzilgandek tuyuladi',
  'lp.lat.sub':
    'Bir soniyadan uzoq pauza uzilgan qo‘ng‘iroqdek qabul qilinadi. Konveyerning har bir bosqichi har navbatda o‘lchanadi va raqam broshyurada emas, dashboardingizda turadi.',
  'lp.lat.b1': 'Nutqni tanish',
  'lp.lat.b2': 'Bilimdan qidirish',
  'lp.lat.b3': 'Javob generatsiyasi',
  'lp.lat.b4': 'Nutq sintezi',
  'lp.lat.target': 'Maqsadli byudjet',
  'lp.lat.arranged': 'Konveyer qanday tuzilgan',
  'lp.lat.step1':
    'Audio uzluksiz oqib keladi — tanish sukunatni kutmasdan, qisman nutq ustida ishlaydi.',
  'lp.lat.step2':
    'Qidiruv leksik BM25 o‘tishini zich vektorlar bilan birlashtiradi, shu bois polis raqamidek aniq atamalar ham, boshqacha aytilgan savollar ham topiladi.',
  'lp.lat.step3':
    'Generatsiya topilgan parchalar bilan cheklanadi va nutq uzunligiga moslab qisqartiriladi; u hech qachon o‘zboshimcha to‘qimaydi.',
  'lp.lat.step4': 'Nutq sintezi tugallangan gapni emas, birinchi bo‘lakni kutmasdan boshlanadi.',

  'lp.roi.eyebrow': 'Biznes asos',
  'lp.roi.title': 'Bu arziydimi — hisoblab ko‘ring',
  'lp.roi.sub':
    'Slayderlarni o‘z raqamlaringizga moslang. Natija manfiy chiqsa, buni shu yerda bilganingiz ma‘qul.',

  'lp.roicalc.calls': 'Oyiga qo‘ng‘iroqlar',
  'lp.roicalc.avg': 'O‘rtacha qo‘ng‘iroq davomiyligi',
  'lp.roicalc.min': 'daq',
  'lp.roicalc.salary': 'Bitta operatorning to‘liq xarajati',
  'lp.roicalc.perMonth': '/ oy',
  'lp.roicalc.deflection': 'AI odamsiz hal qiladigan ulush',
  'lp.roicalc.assumes':
    '22 kunlik oyda operator bandligi 65% deb olinadi. Ovoz faqat rejaga kirgan paketdan ortiq daqiqalar uchun hisoblaydi va shu hajm uchun eng arzon rejani tanlaydi.',
  'lp.roicalc.opNeeded': 'Hozir kerak operatorlar',
  'lp.roicalc.curCost': 'Joriy oylik xarajat',
  'lp.roicalc.opStill': 'Hali kerak operatorlar',
  'lp.roicalc.ovozCost': 'Ovoz: platforma + foydalanish',
  'lp.roicalc.newCost': 'Yangi oylik xarajat',
  'lp.roicalc.saving': 'Oylik tejamkorlik',
  'lp.roicalc.lowerYear': 'faqat odamlar bilan ishlagandan {pct} arzon · yiliga {year}',
  'lp.roicalc.negative':
    'Bu hajmda odamlar jamoasi hali ham arzonroq — baribir yozing, biz shundoq deymiz.',

  'lp.price.eyebrow': 'Narxlar',
  'lp.price.title': 'Narx — operator maoshiga qarab, Silikon vodiysi byudjetiga emas',
  'lp.price.sub':
    'Foydalanish rejaga kirgan daqiqalardan so‘ng daqiqasiga $0.04 hisoblanadi. Saqlab qolgan xodimlaringiz uchun o‘rin solig‘i yo‘q.',
  'lp.price.mostChosen': 'Eng ko‘p tanlanadi',
  'lp.price.perMonth': 'oyiga',
  'lp.price.annual': 'yillik shartnoma',
  'lp.price.p1blurb': 'Bitta raqam, bitta agent — bitta klinika, salon yoki filial uchun.',
  'lp.price.p1f1': 'Oyiga 1 000 tagacha qo‘ng‘iroq',
  'lp.price.p1f2': '1 telefon raqami',
  'lp.price.p1f3': '3 ta jamoa o‘rni',
  'lp.price.p1f4': '500 MB bilim bazasi',
  'lp.price.p1f5': 'Email orqali qo‘llab-quvvatlash',
  'lp.price.p2blurb': 'AI ortida haqiqiy operatorlar jamoasi bilan ko‘p filialli faoliyat.',
  'lp.price.p2f1': 'Oyiga 10 000 tagacha qo‘ng‘iroq',
  'lp.price.p2f2': '5 telefon raqami',
  'lp.price.p2f3': 'Cheksiz o‘rinlar',
  'lp.price.p2f4': 'Operator ish joyi va marshrutlash',
  'lp.price.p2f5': 'API va vebhuklar',
  'lp.price.p2f6': 'Ustuvor qo‘llab-quvvatlash',
  'lp.price.p3blurb': 'Rezidentlik talablari bo‘lgan banklar, sug‘urta va davlat operatorlari.',
  'lp.price.p3f1': 'Cheksiz qo‘ng‘iroq hajmi',
  'lp.price.p3f2': 'On-premise yoki xususiy bulut',
  'lp.price.p3f3': 'Ma‘lumotlar O‘zbekiston ichida qoladi',
  'lp.price.p3f4': 'SSO, audit eksporti, SLA 99.9%',
  'lp.price.p3f5': 'Maxsus integratsiya muhandisi',
  'lp.price.ctaTrial': 'Bepul sinovni boshlash',
  'lp.price.ctaTalk': 'Biz bilan bog‘laning',
  'lp.price.custom': 'Kelishilgan',
  'lp.price.callsUnit': 'qo‘ng‘iroq',
  'lp.price.over': 'keyin',
  'lp.price.paygMetered': 'Daqiqasiga hisoblanadi — paketsiz',
  'lp.price.p0blurb': 'Oylik to‘lovsiz. Faqat ishlatilgan daqiqalar uchun to‘laysiz va arzonroq bo‘lganda rejaga o‘tasiz.',
  'lp.price.p0f2': 'Oylik majburiyatsiz',
  'lp.price.p0f3': 'Istalgan vaqtda rejaga o‘tish',

  'lp.sec.eyebrow': 'Ishonch',
  'lp.sec.title': 'Qiyin savollarni birinchi bo‘lib beradigan sohalar uchun qurilgan',
  'lp.sec.sub':
    'Klinikalar va sug‘urta kompaniyalari beparvo bo‘lib bo‘lmaydigan ma‘lumotlarni saqlaydi. Shu bois zerikarli qismlar ixtiyoriy emas.',
  'lp.sec.i1t': 'Uzatishda ham, saqlashda ham shifrlangan',
  'lp.sec.i1d': 'Hamma joyda TLS 1.2+, saqlanadigan matn va hujjatlar uchun AES-256.',
  'lp.sec.i2t': 'Qattiq ijaralar izolyatsiyasi',
  'lp.sec.i2d':
    'Har bir so‘rov ma‘lumotlar qatlamida sizning ijarangiz bilan cheklanadi. Bir kompaniya boshqasining indeksini hech qachon o‘qiy olmaydi.',
  'lp.sec.i3t': 'So‘rov bo‘yicha rezidentlik',
  'lp.sec.i3d':
    'Korporativ o‘rnatishlar O‘zbekiston ichida — on-premise yoki siz nazorat qiladigan xususiy bulutda ishlaydi.',
  'lp.sec.i4t': 'Saqlash muddatini o‘zingiz belgilaysiz',
  'lp.sec.i4d':
    'Yozuvlar, matnlar va hujjatlar siyosatingizga bo‘ysunadi, kim nimani o‘zgartirgani audit jurnalida qoladi.',

  'lp.cta.title1': 'Bitta hujjat yuklang.',
  'lp.cta.title2': 'U telefonga qanday javob berishini eshiting.',
  'lp.cta.sub':
    'O‘n to‘rt kun, kartasiz, sotuv qo‘ng‘irog‘isiz. Agar u mijozlaringiz savollariga javob bera olmasa, buni bir soat ichida bilasiz.',
  'lp.cta.create': 'Agentingizni yarating',

  'lp.footer.tagline': 'AI mijozlarga xizmat platformasi',
};

const uzCyrl: Dict = {
  'lp.nav.how': 'Қандай ишлайди',
  'lp.nav.languages': 'Тиллар',
  'lp.nav.platform': 'Платформа',
  'lp.nav.roi': 'Фойда',
  'lp.nav.pricing': 'Нархлар',
  'lp.nav.signin': 'Кириш',
  'lp.nav.startFree': 'Бепул бошлаш',
  'lp.nav.openConsole': 'Консолни очиш',

  'lp.hero.badge': 'Ўзбек, рус ва инглиз тилидаги қўнғироқлар учун',
  'lp.hero.title1': 'Ҳужжатларингиз',
  'lp.hero.title2': 'телефонингизга жавоб беради.',
  'lp.hero.sub':
    'Нархлар рўйхати, FAQ ёки қоидалар PDFʻини юкланг. Ovoz уларни бир сониядан камроқ вақтда жавоб берадиган овозли агентга айлантиради: у фақат ҳужжатларингизда ёзилганини айтади ва мураккаб қўнғироқларни тайёр суҳбат хулосаси билан жамоангизга узатади.',
  'lp.hero.ctaConsole': 'Консолни очиш',
  'lp.hero.ctaStart': 'Бепул бошлаш — 14 кун',
  'lp.hero.ctaDemo': 'Жонли қўнғироқни кўриш',
  'lp.hero.trust1': 'Карта керак эмас',
  'lp.hero.trust2': 'Ярим кунда ишга тушади',
  'lp.hero.trust3': 'Маълумотларингиз ўзингизники қолади',

  'lp.problem.stat1': 'Тошкентда битта контакт-марказ ўрнининг ойлик харажати',
  'lp.problem.stat2': 'Кирувчи қўнғироқлар ўша бир неча ўнлаб саволдан иборат',
  'lp.problem.stat3': 'Қўнғироқ қилувчи ўзини эътиборсиз ҳис қилгунича',

  'lp.how.eyebrow': 'Қандай ишлайди',
  'lp.how.title': 'Уч қадам, уч ойлик лойиҳа эмас',
  'lp.how.sub':
    'Гап шундаки, жавобларни сиз аллақачон ёзиб қўйгансиз. Биз уларни телефон орқали жавоб берадиган қилиб берамиз, холос.',
  'lp.how.s1t': 'Бор нарсангизни юкланг',
  'lp.how.s1b':
    'PDF, Word файллар, жадваллар, веб-сайтингиз. Бот конструкторига қайта ёзиш, қарор дарахтлари ёки қўллаб-қувватлаб туриладиган скриптлар керак эмас.',
  'lp.how.s2t': 'Биз билим индексини қурамиз',
  'lp.how.s2b':
    'Ҳужжатлар ўз тузилиши бўйича бўлинади, векторланади ва индексланади — шунда агент саволга жавоб берадиган айнан битта хатбошини топади ва унга ҳавола қилади.',
  'lp.how.s3t': 'Унга рақам уланг',
  'lp.how.s3b':
    'SIP-транк ёки Twilio рақамини уланг. Агент гўшакни кўтаради, қўнғироқ қилувчининг тилида жавоб беради ва ишончсиз бўлган заҳоти одамга узатади.',

  'lp.lang.eyebrow': 'Шу ерда қурилган, кейин локаллаштирилмаган',
  'lp.lang.title': 'Ўзбек тили — тўлақонли тил, белгиланадиган катакча эмас',
  'lp.lang.sub':
    'Ўзбек тили икки алифбода ёзилади ва битта гапда рус тили билан аралаш гапирилади. Глобал платформалар буни истисно деб билади. Биз учун бу — одатий ҳолат.',
  'lp.lang.f1t': 'Лотин ва кирилл битта индексга жамланади',
  'lp.lang.f1d':
    '«шифокор» ва “shifokor” ҳужжатларингиз қандай терилган бўлса ҳам, битта хатбошини топади.',
  'lp.lang.f2t': 'Гап ўртасида тилни алмаштириш — кутилган ҳол',
  'lp.lang.f2d':
    'Ўзбекча бошлаб, рус тилига ўтган қўнғироқ қилувчи ўзи тўхтаган тилда жавоб олади.',
  'lp.lang.f3t': 'Морфологияга чидамли мослаштириш',
  'lp.lang.f3d':
    '«shifokorga», «shifokorlar», «врачу» — ҳаммаси бир тушунчага келади, сизга синоним белгилаш шарт эмас.',

  'lp.feat.eyebrow': 'Платформа',
  'lp.feat.title': 'Унинг ҳақиқий қўнғироқларга дош беришини ҳал қиладиган қисмлар',
  'lp.feat.sub':
    'Сценарийли саволга жавоб берадиган овозли ботни ҳар ким кўрсата олади. Булар эса тўрт юзинчи қўнғироқда аҳамиятли бўлган нарсалар.',
  'lp.feat.f1t': 'Керак бўлганда “йўқ” дейди',
  'lp.feat.f1b':
    'Ҳар бир жавобда ишонч баҳоси бор — қидирув қамрови, фарқ ва лексик кучдан. Сизнинг чегарангиздан паст бўлса, қўнғироқ қилувчи ишончли тахмин эмас, одамни олади.',
  'lp.feat.f2t': 'Контекст бириктирилган ҳолда узатиш',
  'lp.feat.f2b':
    'Оператингиз қўнғироқ қилувчи нима истаётганининг хулосаси, тўлиқ матн ва AI ўқиган айнан ўша парчалар билан жавобга чиқади. “Бошидан қайтаринг” дегани йўқ.',
  'lp.feat.f3t': 'Ҳар бир жавобни излаб бўлади',
  'lp.feat.f3b':
    'Исталган қўнғироқни очинг ва қайси ҳужжат, қайси хатбоши ҳар бир гапни бергани кўринади. Жавоб нотўғри бўлса, қайси файлни тузатишни аниқ биласиз.',
  'lp.feat.f4t': 'Жавоб беролмаган саволларингиз',
  'lp.feat.f4b':
    'Жавобсиз қолган саволлар йиғилиб, частотаси бўйича тартибланади — шунда агентни яхшилаш тахмин ўйини эмас, вазифалар рўйхатига айланади.',
  'lp.feat.f5t': 'Сиз ишлатаётган исталган телефония',
  'lp.feat.f5b':
    'Twilio Elastic SIP, маҳаллий оператор транки ёки мавжуд АТСингиз. Рақамлар, маршрутлаш ва иш соатлари консолда созланади.',
  'lp.feat.f6t': 'Ҳаммасининг остида API',
  'lp.feat.f6b':
    'Калитлар, вебхуклар ва ҳужжатлаштирилган REST — шунда агент жамоангиз аллақачон ишлайдиган CRM ичида тура олади.',

  'lp.lat.eyebrow': 'Кечикиш бюджети',
  'lp.lat.title': 'Бир сониядан кам, акс ҳолда бузилгандек туюлади',
  'lp.lat.sub':
    'Бир сониядан узоқ пауза узилган қўнғироқдек қабул қилинади. Конвейернинг ҳар бир босқичи ҳар навбатда ўлчанади ва рақам брошюрада эмас, дашбордингизда туради.',
  'lp.lat.b1': 'Нутқни таниш',
  'lp.lat.b2': 'Билимдан қидириш',
  'lp.lat.b3': 'Жавоб генерацияси',
  'lp.lat.b4': 'Нутқ синтези',
  'lp.lat.target': 'Мақсадли бюджет',
  'lp.lat.arranged': 'Конвейер қандай тузилган',
  'lp.lat.step1':
    'Аудио узлуксиз оқиб келади — таниш сукунатни кутмасдан, қисман нутқ устида ишлайди.',
  'lp.lat.step2':
    'Қидирув лексик BM25 ўтишини зич векторлар билан бирлаштиради, шу боис полис рақамидек аниқ атамалар ҳам, бошқача айтилган саволлар ҳам топилади.',
  'lp.lat.step3':
    'Генерация топилган парчалар билан чекланади ва нутқ узунлигига мослаб қисқартирилади; у ҳеч қачон ўзбошимча тўқимайди.',
  'lp.lat.step4': 'Нутқ синтези тугалланган гапни эмас, биринчи бўлакни кутмасдан бошланади.',

  'lp.roi.eyebrow': 'Бизнес асос',
  'lp.roi.title': 'Бу арзийдими — ҳисоблаб кўринг',
  'lp.roi.sub':
    'Слайдерларни ўз рақамларингизга мосланг. Натижа манфий чиқса, буни шу ерда билганингиз маъқул.',

  'lp.roicalc.calls': 'Ойига қўнғироқлар',
  'lp.roicalc.avg': 'Ўртача қўнғироқ давомийлиги',
  'lp.roicalc.min': 'дақ',
  'lp.roicalc.salary': 'Битта операторнинг тўлиқ харажати',
  'lp.roicalc.perMonth': '/ ой',
  'lp.roicalc.deflection': 'AI одамсиз ҳал қиладиган улуш',
  'lp.roicalc.assumes':
    '22 кунлик ойда оператор бандлиги 65% деб олинади. Ovoz фақат режага кирган пакетдан ортиқ дақиқалар учун ҳисоблайди ва шу ҳажм учун энг арзон режани танлайди.',
  'lp.roicalc.opNeeded': 'Ҳозир керак операторлар',
  'lp.roicalc.curCost': 'Жорий ойлик харажат',
  'lp.roicalc.opStill': 'Ҳали керак операторлар',
  'lp.roicalc.ovozCost': 'Ovoz: платформа + фойдаланиш',
  'lp.roicalc.newCost': 'Янги ойлик харажат',
  'lp.roicalc.saving': 'Ойлик тежамкорлик',
  'lp.roicalc.lowerYear': 'фақат одамлар билан ишлагандан {pct} арзон · йилига {year}',
  'lp.roicalc.negative':
    'Бу ҳажмда одамлар жамоаси ҳали ҳам арзонроқ — барибир ёзинг, биз шундоқ деймиз.',

  'lp.price.eyebrow': 'Нархлар',
  'lp.price.title': 'Нарх — оператор маошига қараб, Силикон водийси бюджетига эмас',
  'lp.price.sub':
    'Фойдаланиш режага кирган дақиқалардан сўнг дақиқасига $0.04 ҳисобланади. Сақлаб қолган ходимларингиз учун ўрин солиғи йўқ.',
  'lp.price.mostChosen': 'Энг кўп танланади',
  'lp.price.perMonth': 'ойига',
  'lp.price.annual': 'йиллик шартнома',
  'lp.price.p1blurb': 'Битта рақам, битта агент — битта клиника, салон ёки филиал учун.',
  'lp.price.p1f1': 'Ойига 1 000 тагача қўнғироқ',
  'lp.price.p1f2': '1 телефон рақами',
  'lp.price.p1f3': '3 та жамоа ўрни',
  'lp.price.p1f4': '500 MB билим базаси',
  'lp.price.p1f5': 'Email орқали қўллаб-қувватлаш',
  'lp.price.p2blurb': 'AI ортида ҳақиқий операторлар жамоаси билан кўп филиалли фаолият.',
  'lp.price.p2f1': 'Ойига 10 000 тагача қўнғироқ',
  'lp.price.p2f2': '5 телефон рақами',
  'lp.price.p2f3': 'Чексиз ўринлар',
  'lp.price.p2f4': 'Оператор иш жойи ва маршрутлаш',
  'lp.price.p2f5': 'API ва вебхуклар',
  'lp.price.p2f6': 'Устувор қўллаб-қувватлаш',
  'lp.price.p3blurb': 'Резидентлик талаблари бўлган банклар, суғурта ва давлат операторлари.',
  'lp.price.p3f1': 'Чексиз қўнғироқ ҳажми',
  'lp.price.p3f2': 'On-premise ёки хусусий булут',
  'lp.price.p3f3': 'Маълумотлар Ўзбекистон ичида қолади',
  'lp.price.p3f4': 'SSO, аудит экспорти, SLA 99.9%',
  'lp.price.p3f5': 'Махсус интеграция муҳандиси',
  'lp.price.ctaTrial': 'Бепул синовни бошлаш',
  'lp.price.ctaTalk': 'Биз билан боғланинг',
  'lp.price.custom': 'Келишилган',
  'lp.price.callsUnit': 'қўнғироқ',
  'lp.price.over': 'кейин',
  'lp.price.paygMetered': 'Дақиқасига ҳисобланади — пакетсиз',
  'lp.price.p0blurb': 'Ойлик тўловсиз. Фақат ишлатилган дақиқалар учун тўлайсиз ва арзонроқ бўлганда режага ўтасиз.',
  'lp.price.p0f2': 'Ойлик мажбуриятсиз',
  'lp.price.p0f3': 'Исталган вақтда режага ўтиш',

  'lp.sec.eyebrow': 'Ишонч',
  'lp.sec.title': 'Қийин саволларни биринчи бўлиб берадиган соҳалар учун қурилган',
  'lp.sec.sub':
    'Клиникалар ва суғурта компаниялари бепарво бўлиб бўлмайдиган маълумотларни сақлайди. Шу боис зерикарли қисмлар ихтиёрий эмас.',
  'lp.sec.i1t': 'Узатишда ҳам, сақлашда ҳам шифрланган',
  'lp.sec.i1d': 'Ҳамма жойда TLS 1.2+, сақланадиган матн ва ҳужжатлар учун AES-256.',
  'lp.sec.i2t': 'Қаттиқ ижаралар изоляцияси',
  'lp.sec.i2d':
    'Ҳар бир сўров маълумотлар қатламида сизнинг ижарангиз билан чекланади. Бир компания бошқасининг индексини ҳеч қачон ўқий олмайди.',
  'lp.sec.i3t': 'Сўров бўйича резидентлик',
  'lp.sec.i3d':
    'Корпоратив ўрнатишлар Ўзбекистон ичида — on-premise ёки сиз назорат қиладиган хусусий булутда ишлайди.',
  'lp.sec.i4t': 'Сақлаш муддатини ўзингиз белгилайсиз',
  'lp.sec.i4d':
    'Ёзувлар, матнлар ва ҳужжатлар сиёсатингизга бўйсунади, ким нимани ўзгартиргани аудит журналида қолади.',

  'lp.cta.title1': 'Битта ҳужжат юкланг.',
  'lp.cta.title2': 'У телефонга қандай жавоб беришини эшитинг.',
  'lp.cta.sub':
    'Ўн тўрт кун, картасиз, сотув қўнғироғисиз. Агар у мижозларингиз саволларига жавоб бера олмаса, буни бир соат ичида биласиз.',
  'lp.cta.create': 'Агентингизни яратинг',

  'lp.footer.tagline': 'AI мижозларга хизмат платформаси',
};

export const landing: Record<UiLocale, Dict> = { en, ru, uz, 'uz-Cyrl': uzCyrl };
