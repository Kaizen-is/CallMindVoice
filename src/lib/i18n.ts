import type { UiLocale } from './types';
import { landing } from './i18n-landing';
import { CONSOLE_DICTS } from './i18n-console';
import { LABEL_DICTS } from './i18n-labels';

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
  'shell.closeMenu': 'Close menu',
  'shell.openMenu': 'Open menu',

  'reason.low_confidence': 'Not confident enough',
  'reason.explicit_request': 'Caller asked for a human',
  'reason.negative_sentiment': 'Caller was unhappy',
  'reason.repeated_failure': 'Several unanswered questions',
  'reason.after_hours': 'Outside business hours',
  'reason.max_turns': 'Conversation ran long',

  // Auth — login & signup (public pages; follow the header language switcher).
  'auth.email': 'Work email',
  'auth.password': 'Password',
  'auth.showPassword': 'Show password',
  'auth.hidePassword': 'Hide password',

  'auth.login.title': 'Welcome back',
  'auth.login.subtitle': 'Sign in to your CallMind AI console.',
  'auth.login.submit': 'Sign in',
  'auth.login.noAccount': 'No account yet?',
  'auth.login.createOne': 'Create one',
  'auth.login.demoName': 'Demo account.',
  'auth.login.demoUse': 'Sign in with',
  'auth.login.demoTail': 'to explore a clinic with a month of call history already loaded.',

  'auth.signup.heroTitle': 'Fourteen days to find out if this works for you.',
  'auth.signup.heroSub':
    'No card, no sales call. Upload one document and phone your own agent — you will know within the hour whether it can carry your calls.',
  'auth.signup.benefit1': 'A working voice agent in the time it takes to make coffee',
  'auth.signup.benefit2': 'Uzbek, Russian and English out of the box',
  'auth.signup.benefit3': 'Every answer traceable to the document it came from',
  'auth.signup.benefit4': 'Nothing to install — your team just opens a browser',
  'auth.signup.formTitle': 'Create your agent',
  'auth.signup.formSubtitle': 'Takes about a minute.',
  'auth.signup.company': 'Company',
  'auth.signup.industry': 'What do you do?',
  'auth.signup.name': 'Your name',
  'auth.signup.passwordHint': 'At least 8 characters.',
  'auth.signup.submit': 'Create account',
  'auth.signup.terms': 'By continuing you agree to the service terms and privacy policy.',
  'auth.signup.haveAccount': 'Already have an account?',
  'auth.signup.signin': 'Sign in',

  'auth.strength.weak': 'Weak',
  'auth.strength.fair': 'Fair',
  'auth.strength.good': 'Good',
  'auth.strength.strong': 'Strong',

  'auth.err.company': 'Please enter your company name.',
  'auth.err.name': 'Please enter your name.',
  'auth.err.email': 'That email address does not look right.',
  'auth.err.password': 'Use at least 8 characters for your password.',
  'auth.err.createFailed': 'Could not create the account.',
  'auth.err.emailExists': 'An account with this email already exists.',
  'auth.err.credentials': 'Email or password is incorrect.',
  'auth.err.disabled': 'This account has been disabled.',
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
  'shell.closeMenu': 'Закрыть меню',
  'shell.openMenu': 'Открыть меню',

  'reason.low_confidence': 'Недостаточно уверенности',
  'reason.explicit_request': 'Клиент попросил оператора',
  'reason.negative_sentiment': 'Клиент недоволен',
  'reason.repeated_failure': 'Несколько вопросов без ответа',
  'reason.after_hours': 'Вне рабочего времени',
  'reason.max_turns': 'Разговор затянулся',

  // Auth — login & signup.
  'auth.email': 'Рабочая почта',
  'auth.password': 'Пароль',
  'auth.showPassword': 'Показать пароль',
  'auth.hidePassword': 'Скрыть пароль',

  'auth.login.title': 'С возвращением',
  'auth.login.subtitle': 'Войдите в консоль CallMind AI.',
  'auth.login.submit': 'Войти',
  'auth.login.noAccount': 'Ещё нет аккаунта?',
  'auth.login.createOne': 'Создать',
  'auth.login.demoName': 'Демо-аккаунт.',
  'auth.login.demoUse': 'Войдите с',
  'auth.login.demoTail': 'чтобы посмотреть клинику с уже загруженной историей звонков за месяц.',

  'auth.signup.heroTitle': 'Четырнадцать дней, чтобы понять, подходит ли это вам.',
  'auth.signup.heroSub':
    'Без карты, без звонка от продажников. Загрузите один документ и позвоните своему агенту — в течение часа вы поймёте, справится ли он с вашими звонками.',
  'auth.signup.benefit1': 'Рабочий голосовой агент за время, пока варится кофе',
  'auth.signup.benefit2': 'Узбекский, русский и английский — сразу из коробки',
  'auth.signup.benefit3': 'Каждый ответ прослеживается до документа, откуда он взят',
  'auth.signup.benefit4': 'Ничего не нужно устанавливать — команда просто открывает браузер',
  'auth.signup.formTitle': 'Создайте своего агента',
  'auth.signup.formSubtitle': 'Займёт около минуты.',
  'auth.signup.company': 'Компания',
  'auth.signup.industry': 'Чем вы занимаетесь?',
  'auth.signup.name': 'Ваше имя',
  'auth.signup.passwordHint': 'Минимум 8 символов.',
  'auth.signup.submit': 'Создать аккаунт',
  'auth.signup.terms': 'Продолжая, вы соглашаетесь с условиями сервиса и политикой конфиденциальности.',
  'auth.signup.haveAccount': 'Уже есть аккаунт?',
  'auth.signup.signin': 'Войти',

  'auth.strength.weak': 'Слабый',
  'auth.strength.fair': 'Средний',
  'auth.strength.good': 'Хороший',
  'auth.strength.strong': 'Надёжный',

  'auth.err.company': 'Пожалуйста, укажите название компании.',
  'auth.err.name': 'Пожалуйста, укажите ваше имя.',
  'auth.err.email': 'Похоже, адрес электронной почты неверный.',
  'auth.err.password': 'Используйте не менее 8 символов для пароля.',
  'auth.err.createFailed': 'Не удалось создать аккаунт.',
  'auth.err.emailExists': 'Аккаунт с этой почтой уже существует.',
  'auth.err.credentials': 'Неверная почта или пароль.',
  'auth.err.disabled': 'Этот аккаунт отключён.',
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
  'shell.closeMenu': 'Menyuni yopish',
  'shell.openMenu': 'Menyuni ochish',

  'reason.low_confidence': 'Ishonch yetarli emas',
  'reason.explicit_request': 'Mijoz operatorni so‘radi',
  'reason.negative_sentiment': 'Mijoz norozi',
  'reason.repeated_failure': 'Bir necha savol javobsiz qoldi',
  'reason.after_hours': 'Ish vaqtidan tashqari',
  'reason.max_turns': 'Suhbat cho‘zilib ketdi',

  // Auth — login & signup.
  'auth.email': 'Ish elektron pochtasi',
  'auth.password': 'Parol',
  'auth.showPassword': 'Parolni ko‘rsatish',
  'auth.hidePassword': 'Parolni yashirish',

  'auth.login.title': 'Xush kelibsiz',
  'auth.login.subtitle': 'CallMind AI konsolingizga kiring.',
  'auth.login.submit': 'Kirish',
  'auth.login.noAccount': 'Hali hisobingiz yo‘qmi?',
  'auth.login.createOne': 'Yarating',
  'auth.login.demoName': 'Demo hisob.',
  'auth.login.demoUse': '',
  'auth.login.demoTail': 'bilan kiring — bir oylik qo‘ng‘iroq tarixi yuklangan klinikani ko‘rasiz.',

  'auth.signup.heroTitle': 'Bu sizga mos kelishini bilish uchun o‘n to‘rt kun.',
  'auth.signup.heroSub':
    'Kartasiz, sotuv qo‘ng‘irog‘isiz. Bitta hujjat yuklang va o‘z agentingizga qo‘ng‘iroq qiling — u qo‘ng‘iroqlaringizni uddalay oladimi, bir soat ichida bilasiz.',
  'auth.signup.benefit1': 'Qahva damlaguncha ishlaydigan ovozli agent',
  'auth.signup.benefit2': 'O‘zbek, rus va ingliz tillari — darhol',
  'auth.signup.benefit3': 'Har bir javob olingan hujjatgacha izlanadi',
  'auth.signup.benefit4': 'Hech narsa o‘rnatish shart emas — jamoangiz shunchaki brauzer ochadi',
  'auth.signup.formTitle': 'Agentingizni yarating',
  'auth.signup.formSubtitle': 'Bir daqiqacha vaqt oladi.',
  'auth.signup.company': 'Kompaniya',
  'auth.signup.industry': 'Nima bilan shug‘ullanasiz?',
  'auth.signup.name': 'Ismingiz',
  'auth.signup.passwordHint': 'Kamida 8 ta belgi.',
  'auth.signup.submit': 'Hisob yaratish',
  'auth.signup.terms': 'Davom ettirsangiz, xizmat shartlari va maxfiylik siyosatiga rozilik bildirasiz.',
  'auth.signup.haveAccount': 'Hisobingiz bormi?',
  'auth.signup.signin': 'Kirish',

  'auth.strength.weak': 'Zaif',
  'auth.strength.fair': 'O‘rtacha',
  'auth.strength.good': 'Yaxshi',
  'auth.strength.strong': 'Kuchli',

  'auth.err.company': 'Iltimos, kompaniya nomini kiriting.',
  'auth.err.name': 'Iltimos, ismingizni kiriting.',
  'auth.err.email': 'Bu elektron pochta manzili noto‘g‘ri ko‘rinadi.',
  'auth.err.password': 'Parol uchun kamida 8 ta belgidan foydalaning.',
  'auth.err.createFailed': 'Hisob yaratib bo‘lmadi.',
  'auth.err.emailExists': 'Bu pochta bilan hisob allaqachon mavjud.',
  'auth.err.credentials': 'Pochta yoki parol noto‘g‘ri.',
  'auth.err.disabled': 'Bu hisob o‘chirib qo‘yilgan.',
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
  'shell.closeMenu': 'Менюни ёпиш',
  'shell.openMenu': 'Менюни очиш',

  'reason.low_confidence': 'Ишонч етарли эмас',
  'reason.explicit_request': 'Мижоз операторни сўради',
  'reason.negative_sentiment': 'Мижоз норози',
  'reason.repeated_failure': 'Бир неча савол жавобсиз қолди',
  'reason.after_hours': 'Иш вақтидан ташқари',
  'reason.max_turns': 'Суҳбат чўзилиб кетди',

  // Auth — login & signup.
  'auth.email': 'Иш электрон почтаси',
  'auth.password': 'Парол',
  'auth.showPassword': 'Паролни кўрсатиш',
  'auth.hidePassword': 'Паролни яшириш',

  'auth.login.title': 'Хуш келибсиз',
  'auth.login.subtitle': 'CallMind AI консолингизга киринг.',
  'auth.login.submit': 'Кириш',
  'auth.login.noAccount': 'Ҳали ҳисобингиз йўқми?',
  'auth.login.createOne': 'Яратинг',
  'auth.login.demoName': 'Демо ҳисоб.',
  'auth.login.demoUse': '',
  'auth.login.demoTail': 'билан кириб, бир ойлик қўнғироқ тарихи юкланган клиникани кўрасиз.',

  'auth.signup.heroTitle': 'Бу сизга мос келишини билиш учун ўн тўрт кун.',
  'auth.signup.heroSub':
    'Картасиз, сотув қўнғироғисиз. Битта ҳужжат юкланг ва ўз агентингизга қўнғироқ қилинг — у қўнғироқларингизни уддалай оладими, бир соат ичида биласиз.',
  'auth.signup.benefit1': 'Қаҳва дамлагунча ишлайдиган овозли агент',
  'auth.signup.benefit2': 'Ўзбек, рус ва инглиз тиллари — дарҳол',
  'auth.signup.benefit3': 'Ҳар бир жавоб олинган ҳужжатгача изланади',
  'auth.signup.benefit4': 'Ҳеч нарса ўрнатиш шарт эмас — жамоангиз шунчаки браузер очади',
  'auth.signup.formTitle': 'Агентингизни яратинг',
  'auth.signup.formSubtitle': 'Бир дақиқача вақт олади.',
  'auth.signup.company': 'Компания',
  'auth.signup.industry': 'Нима билан шуғулланасиз?',
  'auth.signup.name': 'Исмингиз',
  'auth.signup.passwordHint': 'Камида 8 та белги.',
  'auth.signup.submit': 'Ҳисоб яратиш',
  'auth.signup.terms': 'Давом эттирсангиз, хизмат шартлари ва махфийлик сиёсатига розилик билдирасиз.',
  'auth.signup.haveAccount': 'Ҳисобингиз борми?',
  'auth.signup.signin': 'Кириш',

  'auth.strength.weak': 'Заиф',
  'auth.strength.fair': 'Ўртача',
  'auth.strength.good': 'Яхши',
  'auth.strength.strong': 'Кучли',

  'auth.err.company': 'Илтимос, компания номини киритинг.',
  'auth.err.name': 'Илтимос, исмингизни киритинг.',
  'auth.err.email': 'Бу электрон почта манзили нотўғри кўринади.',
  'auth.err.password': 'Парол учун камида 8 та белгидан фойдаланинг.',
  'auth.err.createFailed': 'Ҳисоб яратиб бўлмади.',
  'auth.err.emailExists': 'Бу почта билан ҳисоб аллақачон мавжуд.',
  'auth.err.credentials': 'Почта ёки парол нотўғри.',
  'auth.err.disabled': 'Бу ҳисоб ўчириб қўйилган.',
};

const DICTS: Record<UiLocale, Dict> = {
  en: { ...en, ...landing.en, ...CONSOLE_DICTS.en, ...LABEL_DICTS.en },
  ru: { ...ru, ...landing.ru, ...CONSOLE_DICTS.ru, ...LABEL_DICTS.ru },
  uz: { ...uz, ...landing.uz, ...CONSOLE_DICTS.uz, ...LABEL_DICTS.uz },
  'uz-Cyrl': { ...uzCyrl, ...landing['uz-Cyrl'], ...CONSOLE_DICTS['uz-Cyrl'], ...LABEL_DICTS['uz-Cyrl'] },
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
