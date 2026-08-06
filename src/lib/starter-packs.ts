/**
 * Starter knowledge packs.
 *
 * A brand-new tenant has nothing to retrieve from, which makes the first
 * playground session useless and the first impression bad. These give the agent
 * something real to answer from in one click — realistic, industry-shaped
 * content that the user then replaces with their own documents.
 */

export interface StarterPack {
  industry: string;
  title: string;
  description: string;
  body: string;
}

const CLINIC = `Ish vaqti va manzil
Medline klinikasi dushanbadan jumagacha 08:00 dan 20:00 gacha ishlaydi. Shanba kuni 09:00 dan 16:00 gacha qabul qilamiz. Yakshanba dam olish kuni.
Manzil: Toshkent shahri, Chilonzor tumani, Bunyodkor ko'chasi 12-uy. Orientir: Chilonzor metro bekatidan 300 metr.
Telefon: +998 71 200 70 70. Qo'shimcha raqam: +998 90 100 70 70 (Telegram va WhatsApp).

Qabul narxlari
Terapevt qabuli — 120 000 so'm.
Kardiolog qabuli — 180 000 so'm. Birinchi konsultatsiya EKG bilan birga.
Nevropatolog qabuli — 170 000 so'm.
LOR (quloq-burun-tomoq) qabuli — 150 000 so'm.
Ginekolog qabuli — 190 000 so'm.
Pediatr qabuli — 130 000 so'm.
Endokrinolog qabuli — 175 000 so'm.
Takroriy qabul 14 kun ichida — 50% chegirma.

Laboratoriya va tekshiruvlar
Umumiy qon tahlili — 60 000 so'm, natija 3 soatda tayyor.
Biokimyoviy tahlil — 145 000 so'm, natija ertasi kuni soat 14:00 ga tayyor.
Qalqonsimon bez gormonlari (TTG, T3, T4) — 210 000 so'm.
UZI qorin bo'shlig'i — 160 000 so'm.
UZI qalqonsimon bez — 110 000 so'm.
EKG — 70 000 so'm.
Rentgen (bitta proyeksiya) — 90 000 so'm.
MRT bosh miya — 850 000 so'm. MRT faqat oldindan yozilish orqali.

Navbatga yozilish
Navbatga telefon orqali, Telegram bot orqali yoki klinikaga kelib yozilish mumkin.
Yozilishda ism-familiya, tug'ilgan sana va telefon raqam kerak bo'ladi.
Qabulga 10 daqiqa oldin kelishingizni so'raymiz.
Bekor qilish kamida 2 soat oldin ma'lum qilinishi kerak.

Kerakli hujjatlar
Birinchi tashrifda pasport yoki ID-karta kerak.
Bolalar uchun — tug'ilganlik haqidagi guvohnoma va ota-onaning pasporti.
Sug'urta bo'yicha kelsangiz — sug'urta polisi va yo'llanma.
Oldingi tahlil natijalari bo'lsa, olib kelishingizni so'raymiz.

Страховка и оплата
Мы работаем со страховыми компаниями: Gross Insurance, Kafolat, Uzbekinvest, Alskom.
При обращении по страховке возьмите с собой полис, паспорт и направление, если оно требуется вашей страховой.
Оплата принимается наличными, картами Uzcard и Humo, а также переводом через Payme и Click.
Чек и справку для страховой выдаём в регистратуре в день приёма.
Возврат средств за неоказанную услугу оформляется в течение 5 рабочих дней через администратора.

Детское отделение
Приём детей ведётся с рождения до 18 лет.
Педиатр принимает ежедневно с 09:00 до 18:00, в субботу до 14:00.
Вакцинация проводится по национальному календарю прививок, по предварительной записи.
Вызов педиатра на дом — 250 000 сум по Ташкенту, заявки принимаются до 16:00.

Results and follow-up
Laboratory results are sent by Telegram and are also available at reception.
Same-day results are ready by 17:00 if the sample was taken before 12:00.
A doctor calls you back within 24 hours if any result is outside the reference range.
Written conclusions in English are available on request at no extra charge.
`;

const INSURANCE = `Полисы и покрытие
Мы оформляем добровольное медицинское страхование (ДМС), страхование от несчастных случаев, автострахование (ОСАГО и КАСКО) и страхование имущества.
Минимальный срок полиса ДМС — 12 месяцев. Полис вступает в силу на следующий день после оплаты.
Базовый пакет ДМС стоит 2 400 000 сум в год на одного человека и покрывает амбулаторный приём, лабораторные анализы и экстренную госпитализацию.
Расширенный пакет — 4 100 000 сум в год, дополнительно включает стоматологию и плановую госпитализацию.
Корпоративные пакеты от 10 сотрудников — скидка 15%, от 50 сотрудников — 25%.

Как оформить полис
Для оформления нужны паспорт, ИНН и заполненная анкета о состоянии здоровья.
Для корпоративного договора дополнительно требуется список сотрудников с датами рождения.
Оформление занимает один рабочий день, полис отправляется в электронном виде.
Оплата принимается переводом на расчётный счёт, картой или через Payme и Click.

Обращение за выплатой
Уведомить нас о страховом случае нужно в течение 5 рабочих дней.
Для выплаты понадобятся: заявление, копия полиса, паспорт, документы из медучреждения или справка из ГАИ.
Решение по выплате принимается в течение 10 рабочих дней с момента подачи полного пакета документов.
Выплата перечисляется на карту или расчётный счёт в течение 3 банковских дней после решения.

Что не покрывается
Не покрываются: косметология, лечение за пределами Узбекистана без предварительного согласования, хронические заболевания, заявленные до начала действия полиса, а также травмы, полученные в состоянии алкогольного опьянения.

Avtosug'urta
OSAGO majburiy sug'urta — yengil avtomobil uchun yiliga 220 000 so'mdan boshlanadi.
KASKO narxi avtomobil qiymatining 3.5–6% ini tashkil qiladi.
Baxtsiz hodisa yuz berganda 24 soat ichida bizga xabar bering va YHXX xulosasini oling.
Ekspertiza 3 ish kuni ichida o'tkaziladi, to'lov esa 10 ish kunida amalga oshiriladi.

Contact and hours
Our office is open Monday to Friday, 09:00 to 18:00, and Saturday 10:00 to 14:00.
The claims hotline runs 24 hours a day on +998 71 205 05 05.
Corporate clients have a dedicated account manager reachable by email within one business day.
`;

const RETAIL = `Buyurtma va yetkazib berish
Buyurtmalar sayt, Telegram bot yoki call-markaz orqali qabul qilinadi.
Toshkent bo'ylab yetkazib berish 25 000 so'm. 500 000 so'mdan yuqori buyurtmalarda bepul.
Viloyatlarga yetkazish 2–4 kun, narxi 45 000 so'mdan boshlanadi.
Bugun soat 15:00 gacha berilgan buyurtma ertaga yetkaziladi.
Kuryer yetib kelishidan 30 daqiqa oldin qo'ng'iroq qiladi.

Qaytarish va almashtirish
Tovarni 14 kun ichida qaytarish mumkin, agar u ishlatilmagan va o'ram butun bo'lsa.
Texnika uchun kafolat 12 oy, ba'zi brendlarda 24 oy.
Nuqsonli tovar aniqlansa, almashtirish 3 ish kunida amalga oshiriladi.
Pulni qaytarish 5–7 ish kunida kartaga o'tkaziladi.

Оплата
Принимаем наличные при получении, карты Uzcard и Humo, Payme, Click и рассрочку.
Рассрочка доступна на 3, 6 и 12 месяцев для заказов от 1 000 000 сум.
Для рассрочки нужен паспорт и подтверждение дохода.
Чек приходит на Telegram сразу после оплаты.

Статус заказа
Статус заказа можно проверить по номеру заказа на сайте или назвав его оператору.
Заказ проходит стадии: принят, собран, передан курьеру, доставлен.
Если заказ задерживается больше чем на сутки, доставка становится бесплатной.

Store hours
Our flagship store is open every day from 10:00 to 22:00.
The call centre answers from 09:00 to 21:00, seven days a week.
Online orders are accepted around the clock.
`;

const GENERIC = `About us and opening hours
We are open Monday to Friday from 09:00 to 18:00 and on Saturday from 10:00 to 15:00. We are closed on Sunday and on public holidays.
Our office is in Tashkent, and the main line is +998 71 200 00 00.
Outside working hours you can leave a message and we call back on the next working day.

Services and pricing
A standard consultation costs 150 000 som and lasts about 30 minutes.
An extended consultation costs 250 000 som and lasts about an hour.
The first introductory call is free of charge and takes around 15 minutes.
Corporate clients are quoted individually depending on volume.

Booking and cancellation
Appointments can be booked by phone, by Telegram, or through our website.
Please arrive ten minutes before your appointment time.
Cancellations made less than two hours in advance are charged at 50%.

Payment
We accept cash, Uzcard and Humo bank cards, and transfers through Payme and Click.
An invoice for a company can be issued on request; it usually takes one working day.
Refunds for services that were not delivered are processed within five working days.

Ish jarayoni
Murojaatingiz qabul qilinganidan so'ng mutaxassis 1 ish kuni ichida bog'lanadi.
Xizmat ko'rsatish shartnoma asosida amalga oshiriladi.
Shikoyat bo'lsa, uni rasmiy ravishda qabul qilamiz va 5 ish kunida javob beramiz.
`;

const PACKS: Record<string, Omit<StarterPack, 'industry'>> = {
  clinic: {
    title: 'Clinic starter knowledge (UZ/RU/EN)',
    description: 'Hours, price list, lab turnaround, insurance, paediatrics and booking rules.',
    body: CLINIC,
  },
  insurance: {
    title: 'Insurance starter knowledge (RU/UZ/EN)',
    description: 'Policy types, pricing, claim process, exclusions and contact hours.',
    body: INSURANCE,
  },
  retail: {
    title: 'Retail starter knowledge (UZ/RU/EN)',
    description: 'Delivery, returns, payment, instalments and order status.',
    body: RETAIL,
  },
};

export function starterPackFor(industry: string): StarterPack {
  const pack = PACKS[industry];
  if (pack) return { industry, ...pack };
  return {
    industry,
    title: 'Starter knowledge (UZ/RU/EN)',
    description: 'Hours, services, pricing, booking and payment — a general-purpose base to replace.',
    body: GENERIC,
  };
}

export function hasTailoredPack(industry: string) {
  return industry in PACKS;
}
