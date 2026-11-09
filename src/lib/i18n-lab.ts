/**
 * Strings for the Models section (Model lab, Voices), the model buttons and
 * the agent's language-model picker. Merged into the main dictionaries in
 * `./i18n`; Uzbek Cyrillic falls back to Uzbek Latin, then English.
 */
import type { UiLocale } from './types';

type Dict = Record<string, string>;

const en: Dict = {
  'nav.section.models': 'Models',
  'nav.devLab': 'Model lab',
  'nav.modelVoices': 'Voices',
  'lab.title': 'Model lab',
  'lab.tab.stt': 'STT',
  'lab.tab.tts': 'TTS',
  'lab.tab.llm': 'LLM',

  'lab.best.accurate': 'Most accurate',
  'lab.best.fastest': 'Fastest',
  'lab.best.cheapest': 'Cheapest',
  'lab.best.clearest': 'Clearest',
  'lab.best.default': 'Default',

  'lab.llm.defaultTitle': 'Default model',
  'lab.llm.serverDefault': 'Server default',
  'lab.llm.default': 'Default',

  'lab.col.engine': 'Engine',
  'lab.col.model': 'Model',
  'lab.col.status': 'Status',
  'lab.col.latency': 'Latency',
  'lab.col.firstSound': 'First sound',
  'lab.col.firstWord': 'First word',
  'lab.col.price': 'Price / min',
  'lab.col.priceTokens': 'Price / 1M tokens',
  'lab.col.wer': 'WER',
  'lab.col.cer': 'CER',
  'lab.col.clarity': 'Clarity',

  'lab.via': 'via {name}',
  'lab.own': 'Own server',
  'lab.ready': 'Ready',
  'lab.missing': 'Needs {setup}',
  'lab.test': 'Test',
  'lab.failTitle': 'That did not work',

  'voices.title': 'Voices',
  'voices.all': 'All',
  'voices.filter': 'Model',
  'voices.listen': 'Listen to',
  'voices.failed': 'Could not play this voice',

  'agent.field.llm': 'Language model',
  'agent.field.llmHint': 'The model that writes the answers. Prices and speed: Models ▸ Model lab ▸ LLM.',
  'agent.field.llmDefault': 'Account default',
  'agent.field.llmNeeds': 'needs {key}',
  'agent.field.ttsModel': 'Voice model',
  'agent.field.ttsModelHint': 'The speech engine that reads the answers. Prices and speed: Models ▸ Model lab ▸ TTS.',
  'agent.field.ttsOwn': 'Own TTS',
  'agent.field.phoneVoice': 'Phone calls still speak with {voice} (own TTS).',
};

const ru: Dict = {
  'nav.section.models': 'Модели',
  'nav.devLab': 'Лаборатория',
  'nav.modelVoices': 'Голоса',
  'lab.title': 'Лаборатория моделей',
  'lab.tab.stt': 'STT',
  'lab.tab.tts': 'TTS',
  'lab.tab.llm': 'LLM',

  'lab.best.accurate': 'Самая точная',
  'lab.best.fastest': 'Самая быстрая',
  'lab.best.cheapest': 'Самая дешёвая',
  'lab.best.clearest': 'Самая разборчивая',
  'lab.best.default': 'По умолчанию',

  'lab.llm.defaultTitle': 'Модель по умолчанию',
  'lab.llm.serverDefault': 'По умолчанию сервера',
  'lab.llm.default': 'По умолчанию',

  'lab.col.engine': 'Движок',
  'lab.col.model': 'Модель',
  'lab.col.status': 'Статус',
  'lab.col.latency': 'Задержка',
  'lab.col.firstSound': 'Первый звук',
  'lab.col.firstWord': 'Первое слово',
  'lab.col.price': 'Цена / мин',
  'lab.col.priceTokens': 'Цена / 1M токенов',
  'lab.col.wer': 'WER',
  'lab.col.cer': 'CER',
  'lab.col.clarity': 'Разборчивость',

  'lab.via': 'через {name}',
  'lab.own': 'Свой сервер',
  'lab.ready': 'Готов',
  'lab.missing': 'Нужно {setup}',
  'lab.test': 'Тест',
  'lab.failTitle': 'Не получилось',

  'voices.title': 'Голоса',
  'voices.all': 'Все',
  'voices.filter': 'Модель',
  'voices.listen': 'Послушать',
  'voices.failed': 'Не удалось воспроизвести голос',

  'agent.field.llm': 'Языковая модель',
  'agent.field.llmHint': 'Модель, которая пишет ответы. Цены и скорость: Модели ▸ Лаборатория ▸ LLM.',
  'agent.field.llmDefault': 'По умолчанию аккаунта',
  'agent.field.llmNeeds': 'нужен {key}',
  'agent.field.ttsModel': 'Модель голоса',
  'agent.field.ttsModelHint': 'Движок, который озвучивает ответы. Цены и скорость: Модели ▸ Лаборатория ▸ TTS.',
  'agent.field.ttsOwn': 'Свой TTS',
  'agent.field.phoneVoice': 'Телефонные звонки пока звучат голосом {voice} (свой TTS).',
};

const uz: Dict = {
  'nav.section.models': 'Modellar',
  'nav.devLab': 'Laboratoriya',
  'nav.modelVoices': 'Ovozlar',
  'lab.title': 'Modellar laboratoriyasi',
  'lab.tab.stt': 'STT',
  'lab.tab.tts': 'TTS',
  'lab.tab.llm': 'LLM',

  'lab.best.accurate': 'Eng aniq',
  'lab.best.fastest': 'Eng tez',
  'lab.best.cheapest': 'Eng arzon',
  'lab.best.clearest': 'Eng ravshan',
  'lab.best.default': 'Standart',

  'lab.llm.defaultTitle': 'Standart model',
  'lab.llm.serverDefault': 'Server standarti',
  'lab.llm.default': 'Standart',

  'lab.col.engine': 'Dvigatel',
  'lab.col.model': 'Model',
  'lab.col.status': 'Holat',
  'lab.col.latency': 'Kechikish',
  'lab.col.firstSound': 'Birinchi tovush',
  'lab.col.firstWord': 'Birinchi so‘z',
  'lab.col.price': 'Narx / daq',
  'lab.col.priceTokens': 'Narx / 1M token',
  'lab.col.wer': 'WER',
  'lab.col.cer': 'CER',
  'lab.col.clarity': 'Aniqlik',

  'lab.via': '{name} orqali',
  'lab.own': 'O‘z serverimiz',
  'lab.ready': 'Tayyor',
  'lab.missing': '{setup} kerak',
  'lab.test': 'Sinash',
  'lab.failTitle': 'Bajarilmadi',

  'voices.title': 'Ovozlar',
  'voices.all': 'Hammasi',
  'voices.filter': 'Model',
  'voices.listen': 'Tinglash',
  'voices.failed': 'Ovozni ijro etib bo‘lmadi',

  'agent.field.llm': 'Til modeli',
  'agent.field.llmHint': 'Javoblarni yozadigan model. Narx va tezlik: Modellar ▸ Laboratoriya ▸ LLM.',
  'agent.field.llmDefault': 'Akkaunt standarti',
  'agent.field.llmNeeds': '{key} kerak',
  'agent.field.ttsModel': 'Ovoz modeli',
  'agent.field.ttsModelHint': 'Javoblarni ovozga aylantiradigan model. Narx va tezlik: Modellar ▸ Laboratoriya ▸ TTS.',
  'agent.field.ttsOwn': 'O‘z TTS',
  'agent.field.phoneVoice': 'Telefon qo‘ng‘iroqlari hozircha {voice} ovozida (o‘z TTS).',
};

export const LAB_DICTS: Record<UiLocale, Dict> = { en, ru, uz, 'uz-Cyrl': {} };
