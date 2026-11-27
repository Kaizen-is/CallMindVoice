/**
 * The phrases of the turn lab (L3), said by real people into the Playground's microphone settings.
 *
 * Each is something a debtor says on a collection call. Where the text has "…" the speaker stops for
 * about a second, as if thinking: that pause is a place where the caller has NOT finished, and the end
 * of the phrase is where they have. `asked` is the agent's line just before (shown to the speaker, and
 * what the Q4 rules read when the two are compared). Speech stays in plain ASCII apostrophes, as the
 * recogniser writes it.
 */

export type PromptKind = 'short' | 'full' | 'pause' | 'number' | 'mixed';

export interface TurnPrompt {
  id: string;
  text: string;
  kind: PromptKind;
  asked?: string;
}

const WHO = 'Siz Aziz Karimovmisiz?';
const WHEN = "Qachon to'lay olasiz?";
const TODAY = "Bugun to'lay olasizmi?";
const HOW_MUCH = "Qancha to'lay olasiz?";

export const TURN_PROMPTS: TurnPrompt[] = [
  // Short answers: finished at once.
  { id: 'p01', kind: 'short', text: 'Ha.', asked: WHO },
  { id: 'p02', kind: 'short', text: "Yo'q.", asked: TODAY },
  { id: 'p03', kind: 'short', text: "Xo'p.", asked: "Ertagacha to'lovni amalga oshiring, iltimos." },
  { id: 'p04', kind: 'short', text: 'Alo?' },
  { id: 'p05', kind: 'short', text: 'Ha, men.', asked: WHO },
  { id: 'p06', kind: 'short', text: 'Kim bu?' },
  { id: 'p07', kind: 'short', text: 'Tushunarli.', asked: 'Kechiktirilgan har bir kun uchun jarima hisoblanadi.' },
  { id: 'p08', kind: 'short', text: 'Rahmat, xayr.', asked: 'Boshqa savollaringiz bormi?' },
  { id: 'p09', kind: 'short', text: 'Ha, eshitaman.' },
  { id: 'p10', kind: 'short', text: 'Kerak emas.', asked: "Sizga to'lov havolasini yuboraymi?" },
  // Whole sentences, said straight through.
  { id: 'p11', kind: 'full', text: "Men bu oy to'lay olmayman.", asked: TODAY },
  { id: 'p12', kind: 'full', text: 'Qancha qarzim qoldi?' },
  { id: 'p13', kind: 'full', text: "Ertaga albatta to'layman.", asked: WHEN },
  { id: 'p14', kind: 'full', text: "Hozir ishdaman, keyinroq qo'ng'iroq qiling." },
  { id: 'p15', kind: 'full', text: 'Men bu kreditni olmaganman.' },
  { id: 'p16', kind: 'full', text: "To'lovni qayerdan qilsam bo'ladi?" },
  { id: 'p17', kind: 'full', text: 'Kechikkanim uchun jarima bormi?' },
  { id: 'p18', kind: 'full', text: "Oylik olganimda to'layman.", asked: WHEN },
  { id: 'p19', kind: 'full', text: "Men allaqachon to'lab bo'ldim." },
  { id: 'p20', kind: 'full', text: 'Iltimos, menga SMS yuboring.' },
  { id: 'p21', kind: 'full', text: 'Bu raqam meniki emas.' },
  { id: 'p22', kind: 'full', text: 'Muddatni uzaytirib bera olasizmi?' },
  { id: 'p23', kind: 'full', text: "Kartamdan avtomatik yechib olsangiz bo'ladimi?" },
  { id: 'p24', kind: 'full', text: 'Men hozir kasalxonadaman.' },
  { id: 'p25', kind: 'full', text: 'Operator bilan gaplashmoqchiman.' },
  // A pause in the middle: not finished there.
  { id: 'p26', kind: 'pause', text: "Men to'layman… lekin keyingi oyda.", asked: WHEN },
  { id: 'p27', kind: 'pause', text: "Pulim bor… faqat hozir qo'limda emas." },
  { id: 'p28', kind: 'pause', text: 'Hozir… bir daqiqa… mashinadaman.' },
  { id: 'p29', kind: 'pause', text: "Men o'ylab ko'raman… keyin sizga aytaman." },
  { id: 'p30', kind: 'pause', text: "Agar muddatni uzaytirsangiz… to'lay olaman." },
  { id: 'p31', kind: 'pause', text: "Qarzim… qancha edi o'zi?" },
  { id: 'p32', kind: 'pause', text: 'Bu kreditni… akam olgan edi.' },
  { id: 'p33', kind: 'pause', text: 'Men… hozir ishsizman.' },
  { id: 'p34', kind: 'pause', text: "Xotinim to'lashi kerak edi… nega to'lamaganini bilmayman." },
  { id: 'p35', kind: 'pause', text: "Hmm… bilmadim… o'ylab ko'raman.", asked: TODAY },
  { id: 'p36', kind: 'pause', text: "Ertaga… yo'q, indinga to'layman.", asked: WHEN },
  { id: 'p37', kind: 'pause', text: 'Bankka bordim… lekin u yopiq ekan.' },
  { id: 'p38', kind: 'pause', text: "Mayli… yarmini hozir to'layman." },
  { id: 'p39', kind: 'pause', text: "Sizga aytdim-ku… pulim yo'q." },
  { id: 'p40', kind: 'pause', text: "To'lov qildim… chekini ham saqlab qo'yganman." },
  { id: 'p41', kind: 'pause', text: 'Kechirasiz… kim bilan gaplashyapman?' },
  { id: 'p42', kind: 'pause', text: "Oyligim… o'ninchi sanada keladi." },
  { id: 'p43', kind: 'pause', text: "Men chet eldaman… qaytib kelganimda to'layman." },
  { id: 'p44', kind: 'pause', text: 'Ha, men… lekin hozir gaplasha olmayman.', asked: WHO },
  { id: 'p45', kind: 'pause', text: "Sizlar har kuni… qo'ng'iroq qilaverasizlar." },
  // Numbers and dates, said in pieces.
  {
    id: 'p46',
    kind: 'number',
    text: "Telefon raqamim… to'qson bir… uch yuz o'n ikki… qirq besh… oltmish yetti.",
    asked: "Siz bilan qaysi raqam orqali bog'lanaylik?",
  },
  { id: 'p47', kind: 'number', text: "Besh yuz ming… so'm to'lay olaman.", asked: HOW_MUCH },
  { id: 'p48', kind: 'number', text: "Yigirma beshinchi… dekabrgacha to'layman.", asked: WHEN },
  {
    id: 'p49',
    kind: 'number',
    text: 'Shartnoma raqamim… yetti, uch, nol, ikki.',
    asked: 'Shartnoma raqamingizni ayta olasizmi?',
  },
  { id: 'p50', kind: 'number', text: "Bir million… ikki yuz ming so'm qoldimi?" },
  { id: 'p51', kind: 'number', text: "O'n beshinchi sanada.", asked: WHEN },
  { id: 'p52', kind: 'number', text: "Uch yuz ming so'm.", asked: HOW_MUCH },
  {
    id: 'p53',
    kind: 'number',
    text: "Kartamning oxirgi raqamlari… to'rt, sakkiz, bir, olti.",
    asked: "Kartangizning oxirgi to'rt raqamini ayting.",
  },
  { id: 'p54', kind: 'number', text: "Har oy… ikki yuz ming so'mdan to'lasam bo'ladimi?" },
  { id: 'p55', kind: 'number', text: "Dushanba… yoki seshanba kuni to'layman.", asked: WHEN },
  // Russian and mixed, as callers often switch.
  { id: 'p56', kind: 'mixed', text: 'Да, слушаю.' },
  { id: 'p57', kind: 'mixed', text: 'Я заплачу… но в следующем месяце.', asked: 'Когда вы сможете оплатить?' },
  { id: 'p58', kind: 'mixed', text: 'Сколько… мне ещё платить?' },
  { id: 'p59', kind: 'mixed', text: 'Ладно… завтра оплачу.' },
  { id: 'p60', kind: 'mixed', text: 'Hozir… секундочку… mashinadaman.' },
];
