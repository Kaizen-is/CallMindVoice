import type { UiLocale } from './types';
import { landing } from './i18n-landing';

/** Order shown in every language picker. Uzbek Latin then Uzbek Cyrillic. */
export const LOCALES: UiLocale[] = ['uz', 'uz-Cyrl', 'ru', 'en'];

/** Full endonym, used in menus and the settings segmented control. */
export const LOCALE_LABEL: Record<UiLocale, string> = {
  en: 'English',
  ru: 'Русский',
  uz: 'O‘zbekcha',
  'uz-Cyrl': 'Ўзбекча',
};

/** Compact tag for the header chip, where space is tight. */
export const LOCALE_SHORT: Record<UiLocale, string> = {
  en: 'EN',
  ru: 'RU',
  uz: 'UZ',
  'uz-Cyrl': 'ЎЗ',
};

/** Which script each UI locale is written in — drives the picker sub-label. */
export const LOCALE_SCRIPT: Record<UiLocale, string> = {
  en: 'Latin',
  ru: 'Кирилл',
  uz: 'Lotin',
  'uz-Cyrl': 'Кирилл',
};

type Dict = Record<string, string>;

const en: Dict = {
  'nav.overview': 'Overview',
  'nav.knowledge': 'Knowledge base',
  'nav.agent': 'Agent studio',
  'nav.playground': 'Playground',
  'nav.live': 'Live calls',
  'nav.inbox': 'Operator inbox',
  'nav.calls': 'Call history',
  'nav.analytics': 'Analytics',
  'nav.numbers': 'Phone numbers',
  'nav.team': 'Team',
  'nav.billing': 'Billing',
  'nav.developers': 'Developers',
  'nav.settings': 'Settings',
  'nav.section.build': 'Build',
  'nav.section.operate': 'Operate',
  'nav.section.measure': 'Measure',
  'nav.section.manage': 'Manage',

  'common.save': 'Save',
  'common.saved': 'Saved',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.search': 'Search',
  'common.loading': 'Loading…',
  'common.retry': 'Retry',
  'common.close': 'Close',
  'common.today': 'Today',
  'common.all': 'All',
  'common.none': 'None',
  'common.language': 'Language',
  'common.theme': 'Theme',
  'common.signOut': 'Sign out',
  'common.upload': 'Upload',
  'common.viewAll': 'View all',
  'common.empty': 'Nothing here yet',

  'kpi.calls': 'Calls handled',
  'kpi.deflection': 'Resolved by AI',
  'kpi.latency': 'Median response',
  'kpi.csat': 'Caller satisfaction',
  'kpi.savings': 'Operator cost avoided',
  'kpi.escalations': 'Escalated to human',
  'kpi.waiting': 'Waiting for operator',
  'kpi.active': 'Live right now',

  'dash.title': 'Overview',
  'dash.subtitle': 'How your AI agent handled the phones.',
  'dash.recentCalls': 'Recent calls',
  'dash.gaps': 'Questions your knowledge base cannot answer',
  'dash.gapsHint': 'Each of these sent a caller to a human. Add a document or an FAQ entry to close the gap.',

  'kb.title': 'Knowledge base',
  'kb.subtitle': 'Everything your agent is allowed to say comes from here.',
  'kb.add': 'Add knowledge',
  'kb.empty': 'Your agent has nothing to answer from',
  'kb.emptyHint': 'Upload a price list, an FAQ, or a policy document to get started.',
  'kb.documents': 'documents',
  'kb.chunks': 'passages',

  'agent.title': 'Agent studio',
  'agent.subtitle': 'Voice, personality, languages and when to hand over to a human.',

  'play.title': 'Playground',
  'play.subtitle': 'Talk to your agent exactly as a caller would — with your real knowledge base.',
  'play.speak': 'Hold to speak',
  'play.listening': 'Listening…',
  'play.thinking': 'Thinking…',

  'live.title': 'Live calls',
  'live.subtitle': 'Every call in flight, updating in real time.',
  'live.noCalls': 'No calls in progress',

  'inbox.title': 'Operator inbox',
  'inbox.subtitle': 'Calls the AI handed over, with everything you need to take over instantly.',
  'inbox.accept': 'Take this call',
  'inbox.resolve': 'Mark resolved',
  'inbox.summary': 'AI summary',
  'inbox.transcript': 'Transcript',
  'inbox.sources': 'Sources the AI consulted',
  'inbox.empty': 'No one is waiting',
  'inbox.emptyHint': 'The AI is handling everything on its own right now.',
  'inbox.queue': 'Queue',
  'inbox.waiting': 'waiting',

  'shell.collapse': 'Collapse',
  'shell.quiet': 'Lines quiet',
  'shell.liveOne': '1 call live',
  'shell.liveMany': '{n} calls live',

  'reason.low_confidence': 'Not confident enough',
  'reason.explicit_request': 'Caller asked for a human',
  'reason.negative_sentiment': 'Caller was unhappy',
  'reason.repeated_failure': 'Several unanswered questions',
  'reason.after_hours': 'Outside business hours',
  'reason.max_turns': 'Conversation ran long',
};

const ru: Dict = {
  'nav.overview': 'Обзор',
  'nav.knowledge': 'База знаний',
  'nav.agent': 'Студия агента',
  'nav.playground': 'Песочница',
  'nav.live': 'Живые звонки',
  'nav.inbox': 'Очередь оператора',
  'nav.calls': 'История звонков',
  'nav.analytics': 'Аналитика',
  'nav.numbers': 'Номера',
  'nav.team': 'Команда',
  'nav.billing': 'Оплата',
  'nav.developers': 'Разработчикам',
  'nav.settings': 'Настройки',
  'nav.section.build': 'Настройка',
  'nav.section.operate': 'Работа',
  'nav.section.measure': 'Аналитика',
  'nav.section.manage': 'Управление',

  'common.save': 'Сохранить',
  'common.saved': 'Сохранено',
  'common.cancel': 'Отмена',
  'common.delete': 'Удалить',
  'common.search': 'Поиск',
  'common.loading': 'Загрузка…',
  'common.retry': 'Повторить',
  'common.close': 'Закрыть',
  'common.today': 'Сегодня',
  'common.all': 'Все',
  'common.none': 'Нет',
  'common.language': 'Язык',
  'common.theme': 'Тема',
  'common.signOut': 'Выйти',
  'common.upload': 'Загрузить',
  'common.viewAll': 'Показать все',
  'common.empty': 'Пока пусто',

  'kpi.calls': 'Обработано звонков',
  'kpi.deflection': 'Решено ИИ',
  'kpi.latency': 'Медианный ответ',
  'kpi.csat': 'Оценка клиентов',
  'kpi.savings': 'Сэкономлено на операторах',
  'kpi.escalations': 'Передано человеку',
  'kpi.waiting': 'Ждут оператора',
  'kpi.active': 'Сейчас в эфире',

  'dash.title': 'Обзор',
  'dash.subtitle': 'Как ИИ-агент справляется с телефонией.',
  'dash.recentCalls': 'Последние звонки',
  'dash.gaps': 'Вопросы, на которые база знаний не отвечает',
  'dash.gapsHint': 'Каждый из них отправил клиента к человеку. Добавьте документ или FAQ, чтобы закрыть пробел.',

  'kb.title': 'База знаний',
  'kb.subtitle': 'Агент отвечает только тем, что есть здесь.',
  'kb.add': 'Добавить знания',
  'kb.empty': 'Агенту пока не из чего отвечать',
  'kb.emptyHint': 'Загрузите прайс-лист, FAQ или регламент, чтобы начать.',
  'kb.documents': 'документов',
  'kb.chunks': 'фрагментов',

  'agent.title': 'Студия агента',
  'agent.subtitle': 'Голос, характер, языки и правила передачи оператору.',

  'play.title': 'Песочница',
  'play.subtitle': 'Поговорите с агентом так же, как клиент — на вашей реальной базе знаний.',
  'play.speak': 'Удерживайте, чтобы говорить',
  'play.listening': 'Слушаю…',
  'play.thinking': 'Думаю…',

  'live.title': 'Живые звонки',
  'live.subtitle': 'Все текущие звонки в реальном времени.',
  'live.noCalls': 'Активных звонков нет',

  'inbox.title': 'Очередь оператора',
  'inbox.subtitle': 'Звонки, переданные ИИ, со всем контекстом для мгновенного подхвата.',
  'inbox.accept': 'Взять звонок',
  'inbox.resolve': 'Закрыть',
  'inbox.summary': 'Сводка ИИ',
  'inbox.transcript': 'Расшифровка',
  'inbox.sources': 'Источники ИИ',
  'inbox.empty': 'Никто не ждёт',
  'inbox.emptyHint': 'Сейчас ИИ справляется полностью самостоятельно.',
  'inbox.queue': 'Очередь',
  'inbox.waiting': 'в ожидании',

  'shell.collapse': 'Свернуть',
  'shell.quiet': 'Линии свободны',
  'shell.liveOne': '1 звонок в эфире',
  'shell.liveMany': 'звонков в эфире: {n}',

  'reason.low_confidence': 'Недостаточно уверенности',
  'reason.explicit_request': 'Клиент попросил оператора',
  'reason.negative_sentiment': 'Клиент недоволен',
  'reason.repeated_failure': 'Несколько вопросов без ответа',
  'reason.after_hours': 'Вне рабочего времени',
  'reason.max_turns': 'Разговор затянулся',
};

const uz: Dict = {
  'nav.overview': 'Umumiy ko‘rinish',
  'nav.knowledge': 'Bilimlar bazasi',
  'nav.agent': 'Agent studiyasi',
  'nav.playground': 'Sinov maydoni',
  'nav.live': 'Jonli qo‘ng‘iroqlar',
  'nav.inbox': 'Operator navbati',
  'nav.calls': 'Qo‘ng‘iroqlar tarixi',
  'nav.analytics': 'Tahlil',
  'nav.numbers': 'Telefon raqamlar',
  'nav.team': 'Jamoa',
  'nav.billing': 'To‘lovlar',
  'nav.developers': 'Dasturchilarga',
  'nav.settings': 'Sozlamalar',
  'nav.section.build': 'Sozlash',
  'nav.section.operate': 'Ish jarayoni',
  'nav.section.measure': 'O‘lchash',
  'nav.section.manage': 'Boshqaruv',

  'common.save': 'Saqlash',
  'common.saved': 'Saqlandi',
  'common.cancel': 'Bekor qilish',
  'common.delete': 'O‘chirish',
  'common.search': 'Qidiruv',
  'common.loading': 'Yuklanmoqda…',
  'common.retry': 'Qayta urinish',
  'common.close': 'Yopish',
  'common.today': 'Bugun',
  'common.all': 'Hammasi',
  'common.none': 'Yo‘q',
  'common.language': 'Til',
  'common.theme': 'Mavzu',
  'common.signOut': 'Chiqish',
  'common.upload': 'Yuklash',
  'common.viewAll': 'Barchasini ko‘rish',
  'common.empty': 'Hozircha bo‘sh',

  'kpi.calls': 'Qabul qilingan qo‘ng‘iroqlar',
  'kpi.deflection': 'AI hal qilgan',
  'kpi.latency': 'O‘rtacha javob vaqti',
  'kpi.csat': 'Mijoz bahosi',
  'kpi.savings': 'Tejalgan operator xarajati',
  'kpi.escalations': 'Operatorga uzatilgan',
  'kpi.waiting': 'Operatorni kutmoqda',
  'kpi.active': 'Hozir efirda',

  'dash.title': 'Umumiy ko‘rinish',
  'dash.subtitle': 'AI agent telefoniyani qanday uddalayapti.',
  'dash.recentCalls': 'So‘nggi qo‘ng‘iroqlar',
  'dash.gaps': 'Bilimlar bazasi javob bera olmagan savollar',
  'dash.gapsHint': 'Har biri mijozni operatorga yubordi. Hujjat yoki FAQ qo‘shib, bo‘shliqni yoping.',

  'kb.title': 'Bilimlar bazasi',
  'kb.subtitle': 'Agent faqat shu yerdagi ma’lumot asosida javob beradi.',
  'kb.add': 'Bilim qo‘shish',
  'kb.empty': 'Agentda javob berish uchun ma’lumot yo‘q',
  'kb.emptyHint': 'Narxlar ro‘yxati, FAQ yoki qoidalarni yuklang.',
  'kb.documents': 'hujjat',
  'kb.chunks': 'fragment',

  'agent.title': 'Agent studiyasi',
  'agent.subtitle': 'Ovoz, xarakter, tillar va operatorga uzatish qoidalari.',

  'play.title': 'Sinov maydoni',
  'play.subtitle': 'Agent bilan xuddi mijoz kabi gaplashing — haqiqiy bilimlar bazangizda.',
  'play.speak': 'Gapirish uchun ushlab turing',
  'play.listening': 'Tinglayapman…',
  'play.thinking': 'O‘ylayapman…',

  'live.title': 'Jonli qo‘ng‘iroqlar',
  'live.subtitle': 'Barcha faol qo‘ng‘iroqlar real vaqtda.',
  'live.noCalls': 'Faol qo‘ng‘iroq yo‘q',

  'inbox.title': 'Operator navbati',
  'inbox.subtitle': 'AI uzatgan qo‘ng‘iroqlar — darhol davom ettirish uchun barcha kontekst bilan.',
  'inbox.accept': 'Qo‘ng‘iroqni olish',
  'inbox.resolve': 'Yakunlash',
  'inbox.summary': 'AI xulosasi',
  'inbox.transcript': 'Matn yozuvi',
  'inbox.sources': 'AI ishlatgan manbalar',
  'inbox.empty': 'Hech kim kutmayapti',
  'inbox.emptyHint': 'Hozircha AI hammasini mustaqil hal qilyapti.',
  'inbox.queue': 'Navbat',
  'inbox.waiting': 'kutmoqda',

  'shell.collapse': 'Yig‘ish',
  'shell.quiet': 'Liniyalar bo‘sh',
  'shell.liveOne': '1 ta qo‘ng‘iroq efirda',
  'shell.liveMany': 'efirdagi qo‘ng‘iroqlar: {n}',

  'reason.low_confidence': 'Ishonch yetarli emas',
  'reason.explicit_request': 'Mijoz operatorni so‘radi',
  'reason.negative_sentiment': 'Mijoz norozi',
  'reason.repeated_failure': 'Bir necha savol javobsiz qoldi',
  'reason.after_hours': 'Ish vaqtidan tashqari',
  'reason.max_turns': 'Suhbat cho‘zilib ketdi',
};

/**
 * Uzbek Cyrillic. Uzbekistan still writes Uzbek in both scripts day to day, so
 * this is a hand-authored transliteration of the Latin dictionary above rather
 * than a runtime fold — Latin→Cyrillic is lossy (e/э, ye) and a contact-centre
 * console is exactly where getting it wrong is noticed.
 */
const uzCyrl: Dict = {
  'nav.overview': 'Умумий кўриниш',
  'nav.knowledge': 'Билимлар базаси',
  'nav.agent': 'Агент студияси',
  'nav.playground': 'Синов майдони',
  'nav.live': 'Жонли қўнғироқлар',
  'nav.inbox': 'Оператор навбати',
  'nav.calls': 'Қўнғироқлар тарихи',
  'nav.analytics': 'Таҳлил',
  'nav.numbers': 'Телефон рақамлар',
  'nav.team': 'Жамоа',
  'nav.billing': 'Тўловлар',
  'nav.developers': 'Дастурчиларга',
  'nav.settings': 'Созламалар',
  'nav.section.build': 'Созлаш',
  'nav.section.operate': 'Иш жараёни',
  'nav.section.measure': 'Ўлчаш',
  'nav.section.manage': 'Бошқарув',

  'common.save': 'Сақлаш',
  'common.saved': 'Сақланди',
  'common.cancel': 'Бекор қилиш',
  'common.delete': 'Ўчириш',
  'common.search': 'Қидирув',
  'common.loading': 'Юкланмоқда…',
  'common.retry': 'Қайта уриниш',
  'common.close': 'Ёпиш',
  'common.today': 'Бугун',
  'common.all': 'Ҳаммаси',
  'common.none': 'Йўқ',
  'common.language': 'Тил',
  'common.theme': 'Мавзу',
  'common.signOut': 'Чиқиш',
  'common.upload': 'Юклаш',
  'common.viewAll': 'Барчасини кўриш',
  'common.empty': 'Ҳозирча бўш',

  'kpi.calls': 'Қабул қилинган қўнғироқлар',
  'kpi.deflection': 'AI ҳал қилган',
  'kpi.latency': 'Ўртача жавоб вақти',
  'kpi.csat': 'Мижоз баҳоси',
  'kpi.savings': 'Тежалган оператор харажати',
  'kpi.escalations': 'Операторга узатилган',
  'kpi.waiting': 'Операторни кутмоқда',
  'kpi.active': 'Ҳозир эфирда',

  'dash.title': 'Умумий кўриниш',
  'dash.subtitle': 'AI агент телефонияни қандай уддалаяпти.',
  'dash.recentCalls': 'Сўнгги қўнғироқлар',
  'dash.gaps': 'Билимлар базаси жавоб бера олмаган саволлар',
  'dash.gapsHint': 'Ҳар бири мижозни операторга юборди. Ҳужжат ёки FAQ қўшиб, бўшлиқни ёпинг.',

  'kb.title': 'Билимлар базаси',
  'kb.subtitle': 'Агент фақат шу ердаги маълумот асосида жавоб беради.',
  'kb.add': 'Билим қўшиш',
  'kb.empty': 'Агентда жавоб бериш учун маълумот йўқ',
  'kb.emptyHint': 'Нархлар рўйхати, FAQ ёки қоидаларни юкланг.',
  'kb.documents': 'ҳужжат',
  'kb.chunks': 'фрагмент',

  'agent.title': 'Агент студияси',
  'agent.subtitle': 'Овоз, характер, тиллар ва операторга узатиш қоидалари.',

  'play.title': 'Синов майдони',
  'play.subtitle': 'Агент билан худди мижоз каби гаплашинг — ҳақиқий билимлар базангизда.',
  'play.speak': 'Гапириш учун ушлаб туринг',
  'play.listening': 'Тинглаяпман…',
  'play.thinking': 'Ўйлаяпман…',

  'live.title': 'Жонли қўнғироқлар',
  'live.subtitle': 'Барча фаол қўнғироқлар реал вақтда.',
  'live.noCalls': 'Фаол қўнғироқ йўқ',

  'inbox.title': 'Оператор навбати',
  'inbox.subtitle': 'AI узатган қўнғироқлар — дарҳол давом эттириш учун барча контекст билан.',
  'inbox.accept': 'Қўнғироқни олиш',
  'inbox.resolve': 'Якунлаш',
  'inbox.summary': 'AI хулосаси',
  'inbox.transcript': 'Матн ёзуви',
  'inbox.sources': 'AI ишлатган манбалар',
  'inbox.empty': 'Ҳеч ким кутмаяпти',
  'inbox.emptyHint': 'Ҳозирча AI ҳаммасини мустақил ҳал қиляпти.',
  'inbox.queue': 'Навбат',
  'inbox.waiting': 'кутмоқда',

  'shell.collapse': 'Йиғиш',
  'shell.quiet': 'Линиялар бўш',
  'shell.liveOne': '1 та қўнғироқ эфирда',
  'shell.liveMany': 'эфирдаги қўнғироқлар: {n}',

  'reason.low_confidence': 'Ишонч етарли эмас',
  'reason.explicit_request': 'Мижоз операторни сўради',
  'reason.negative_sentiment': 'Мижоз норози',
  'reason.repeated_failure': 'Бир неча савол жавобсиз қолди',
  'reason.after_hours': 'Иш вақтидан ташқари',
  'reason.max_turns': 'Суҳбат чўзилиб кетди',
};

const DICTS: Record<UiLocale, Dict> = {
  en: { ...en, ...landing.en },
  ru: { ...ru, ...landing.ru },
  uz: { ...uz, ...landing.uz },
  'uz-Cyrl': { ...uzCyrl, ...landing['uz-Cyrl'] },
};

/**
 * Per-locale lookup order. Uzbek Cyrillic falls back to Uzbek Latin (same
 * language, other script) before English, so a key added to `uz` but not yet
 * transliterated still shows Uzbek rather than jumping to English.
 */
const FALLBACK: Record<UiLocale, UiLocale[]> = {
  en: ['en'],
  ru: ['ru', 'en'],
  uz: ['uz', 'en'],
  'uz-Cyrl': ['uz-Cyrl', 'uz', 'en'],
};

export function translator(locale: UiLocale) {
  const chain = FALLBACK[locale] ?? ['en'];
  return (key: string, fallback?: string) => {
    for (const loc of chain) {
      const hit = DICTS[loc][key];
      if (hit !== undefined) return hit;
    }
    return fallback ?? key;
  };
}

export type Translate = ReturnType<typeof translator>;
