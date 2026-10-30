/**
 * Every word the demo shows, in both of its languages. Uzbek uses the proper
 * letters — ʻ (U+02BB) in oʻ/gʻ — not a typewriter apostrophe.
 */
import type { DemoLang } from '@/lib/demo-shared';

export interface Copy {
  incoming: string;
  answer: string;
  connecting: string;
  listening: string;
  hearing: string;
  thinking: string;
  speaking: string;
  muted: string;
  ended: string;
  transferred: string;
  redial: string;
  mute: string;
  unmute: string;
  hangUp: string;
  interrupt: string;
  persona: (name: string, year: string) => string;
  heardNothing: string;
  network: string;
  busy: string;
  micDenied: string;
  micDeniedHint: string;
  micMissing: string;
  unsupported: string;
  unavailable: string;
  transcript: string;
  language: string;
  voice: string;
  agentVoice: string;
  voiceGroups: { builtin: string; clone: string; design: string };
}

export const COPY: Record<DemoLang, Copy> = {
  uz: {
    incoming: 'Kiruvchi qoʻngʻiroq',
    answer: 'Javob berish',
    connecting: 'Ulanmoqda',
    listening: 'Gapiring',
    hearing: 'Eshitmoqda',
    thinking: 'Oʻylamoqda',
    speaking: 'Gapirmoqda',
    muted: 'Mikrofon oʻchiq',
    ended: 'Qoʻngʻiroq yakunlandi',
    transferred: 'Operatorga uzatildi',
    redial: 'Qayta qoʻngʻiroq',
    mute: 'Mikrofonni oʻchirish',
    unmute: 'Mikrofonni yoqish',
    hangUp: 'Qoʻngʻiroqni tugatish',
    interrupt: 'Gapini boʻlish',
    persona: (name, year) => `Siz — ${name} · ${year}`,
    heardNothing: 'Eshitilmadi — qaytadan ayting',
    network: 'Aloqa uzildi — qaytadan ayting',
    busy: 'Liniya band. Birozdan soʻng qoʻngʻiroq qiling',
    micDenied: 'Mikrofonga ruxsat bering',
    micDeniedHint: 'Manzil satridagi qulf belgisini bosing',
    micMissing: 'Mikrofon topilmadi',
    unsupported: 'Bu brauzer ovozli qoʻngʻiroqni qoʻllamaydi',
    unavailable: 'Demo vaqtincha ishlamayapti',
    transcript: 'Suhbat',
    language: 'Til',
    voice: 'Ovoz',
    agentVoice: 'Agent ovozi',
    voiceGroups: { builtin: 'Asosiy ovozlar', clone: 'Klonlangan', design: 'Yaratilgan' },
  },
  ru: {
    incoming: 'Входящий звонок',
    answer: 'Ответить',
    connecting: 'Соединение',
    listening: 'Говорите',
    hearing: 'Слушает',
    thinking: 'Думает',
    speaking: 'Говорит',
    muted: 'Микрофон выключен',
    ended: 'Звонок завершён',
    transferred: 'Переведён на оператора',
    redial: 'Позвонить снова',
    mute: 'Выключить микрофон',
    unmute: 'Включить микрофон',
    hangUp: 'Завершить звонок',
    interrupt: 'Перебить',
    persona: (name, year) => `Вы — ${name} · ${year}`,
    heardNothing: 'Не расслышал — повторите',
    network: 'Связь прервалась — повторите',
    busy: 'Линия занята. Попробуйте чуть позже',
    micDenied: 'Разрешите доступ к микрофону',
    micDeniedHint: 'Нажмите на значок замка в адресной строке',
    micMissing: 'Микрофон не найден',
    unsupported: 'Этот браузер не поддерживает голосовые звонки',
    unavailable: 'Демо временно недоступно',
    transcript: 'Разговор',
    language: 'Язык',
    voice: 'Голос',
    agentVoice: 'Голос агента',
    voiceGroups: { builtin: 'Базовые голоса', clone: 'Клонированные', design: 'Созданные' },
  },
};
