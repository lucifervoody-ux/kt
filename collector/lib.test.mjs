import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRubles, parsePrices, parseBenefits, parseAmounts, cleanModel, mergeModels, validateModels, diffModels, decideChange, diffDetails, historyToDelete, formatRub, CHANGE,
} from './lib.mjs';

test('разбор цен в разных записях', () => {
  assert.deepEqual(parseRubles('2 199 000 ₽'), [2199000]);
  assert.deepEqual(parseRubles('2199000 руб.'), [2199000]);
  assert.deepEqual(parseRubles('от 2,199 млн ₽'), [2199000]);
  assert.deepEqual(parseRubles('выгода до 300 тыс. ₽'), [300000]);
  assert.deepEqual(parseRubles('от 1 899 000 ₽'), [1899000]);
  assert.deepEqual(parseRubles('2 499 000 ₽ 2 299 000 ₽'), [2499000, 2299000]);
  assert.deepEqual(parseRubles('Tiggo 7'), []);
});

test('одна модель — одна строка', () => {
  const rows = mergeModels([
    { model: 'T7 ', price: 2299000, max_benefit: 100000 },
    { model: 't7', price: 2199000, max_benefit: 300000 },
    { model: 'T4', price: '-', max_benefit: '-' },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].price, 2199000);
  assert.equal(rows[0].max_benefit, 300000);
});

test('подозрительные цифры', () => {
  assert.equal(validateModels([{ model: 'A', price: 1000, max_benefit: '-' }]).length, 1);
  assert.equal(validateModels([{ model: 'A', price: 2000000, max_benefit: 3000000 }]).length, 1);
  assert.equal(validateModels([{ model: 'A', price: 2000000, max_benefit: 300000 }]).length, 0);
});

test('сравнение с прошлым сбором', () => {
  const prev = [
    { model: 'T7', price: 2199000, max_benefit: 300000 },
    { model: 'A8', price: 1500000, max_benefit: '-' },
  ];
  const curr = [
    { model: 't7', price: 2299000, max_benefit: 300000 },
    { model: 'Tiggo 9', price: 3499000, max_benefit: 400000 },
  ];
  assert.deepEqual(diffModels(prev, curr), [
    't7: 2 199 000 ₽/300 000 ₽ → 2 299 000 ₽/300 000 ₽',
    'Новая модель: Tiggo 9 3 499 000 ₽/400 000 ₽',
    'Модель пропала: A8',
  ]);
});

test('статусы сайта', () => {
  const site = { status: 'ok', models: [{ model: 'T7', price: 1, max_benefit: '-' }] };
  assert.equal(decideChange(site, null).change, CHANGE.first);
  assert.equal(decideChange(site, site).change, CHANGE.same);
  assert.equal(decideChange({ status: 'access_error', models: [] }, site).change, CHANGE.error);
});

test('чистка истории: старое удаляем, самое свежее оставляем', () => {
  assert.deepEqual(historyToDelete(['2026-01-01', '2026-06-01', '2026-10-01'], '2026-10-29'), [
    '2026-01-01', '2026-06-01',
  ]);
  assert.deepEqual(historyToDelete(['2025-01-01'], '2026-10-29'), []);
});

test('формат рублей', () => {
  assert.equal(formatRub(2199000), '2 199 000 ₽');
  assert.equal(formatRub('-'), '-');
});

test('чистка названия модели', () => {
  assert.equal(cleanModel('TENET\u00a0T8 - от 2\u00a0899\u00a0000\u00a0₽*', 'Tenet'), 'T8');
  assert.equal(cleanModel('TENET T7 от 2 625 000 ₽*', 'Tenet'), 'T7');
  assert.equal(cleanModel('Tiggo 8 Pro Max', 'Chery'), 'Tiggo 8 Pro Max');
  assert.equal(cleanModel('Chery Tiggo 4 2 199 000 ₽', 'Chery'), 'Tiggo 4');
  assert.equal(cleanModel(' T4L ', 'Tenet'), 'T4L');
  assert.equal(cleanModel('Ли Л6 | Li L6', 'Li'), 'L6');
  assert.equal(cleanModel('TANK 300', 'TANK'), '300');
  assert.equal(cleanModel('Л9 Ливис I L9 Livis', 'Li'), 'L9 Livis');
  assert.equal(cleanModel('Ли Л6 | Li L6¹', 'Li'), 'L6');
});

test('выгоды: только то, что названо выгодой', () => {
  assert.deepEqual(parseBenefits('ВЫГОДА ПО ТРЕЙД-ИН ДО 100 000 РУБ.'), [100000]);
  assert.deepEqual(parseBenefits('TENET T4L С ЕЖЕМЕСЯЧНЫМ ПЛАТЕЖОМ ОТ 16 000,0 ₽**'), []);
  assert.deepEqual(parseBenefits('Выгода в лизинг до 500 000 ₽'), []);
  assert.deepEqual(
    parseBenefits('Ваши уникальные преимущества:\nВыгода по трейд-ин - 200 000 ₽**\nПрограмма выгодный кредит - 50 000 ₽***'),
    [200000, 50000],
  );
  assert.deepEqual(parseBenefits('Цена 2 199 000 ₽'), []);
  assert.deepEqual(parseBenefits('Максимальная выгода\nдо 100 000 ₽'), [100000]);
  assert.deepEqual(parseBenefits('Выгода по программе «TENET Легко» - 145 000**'), [145000]);
  assert.deepEqual(
    parseBenefits('Цена на модель TANK 400 в комплектации Премиум 2026 года выпуска с учетом прямой выгоды в 250 000 рублей, с учетом выгоды по трейд-ин в 250 000 рублей, с учетом дополнительной выгоды по лояльному трейд-ин в 200 000 рублей при сдаче. Ставка 5%'),
    [250000, 250000, 200000],
  );
  assert.deepEqual(parseBenefits('с учетом максимальной выгоды от 4 099 000'), []);
});

test('изменения списком для приложения', () => {
  const d = diffDetails(
    [{ model: 'T7', price: 2199000, max_benefit: 300000 }, { model: 'A8', price: 1, max_benefit: '-' }],
    [{ model: 'T7', price: 2299000, max_benefit: 300000 }, { model: 'T9', price: 3, max_benefit: '-' }],
  );
  assert.deepEqual(d.map((x) => x.type), ['changed', 'new', 'gone']);
  assert.equal(d[0].was.price, 2199000);
  assert.equal(d[0].now.price, 2299000);
});

test('цена: берём суммы после «от», а не из сносок', () => {
  assert.deepEqual(parsePrices('от 4 099 000 ₽ *Цена с учетом выгоды по трейд-ин в 200 000 рублей, 2026 года'), [4099000]);
  assert.deepEqual(parsePrices('2 625 000 ₽'), [2625000]);
  assert.deepEqual(parsePrices('4 430 000 ₽ 5 349 000 ₽ от 30 131 ₽ /мес'), [4430000, 5349000]);
  assert.deepEqual(parsePrices('от 2 799 000 ₽ или от 14 770 ₽/мес'), [2799000]);
  assert.deepEqual(parsePrices('ОТ 2 199 000 ₽*'), [2199000]);
});

test('все суммы как выгоды (benefit_all)', () => {
  assert.deepEqual(parseAmounts('Для комплектации Про / Pro - 980 000 рублей Для комплектации Макс / Max - 1 027 000 рублей'), [980000, 1027000]);
  assert.deepEqual(parseAmounts('автомобили 2025 года, 300 000 ₽'), [300000]);
});

// «Сайт-ловушка»: запутанные фразы, на которых сборщик не должен ошибиться.
test('ловушки: выгоды', () => {
  const max = (t) => { const a = parseBenefits(t); return a.length ? Math.max(...a) : null; };
  const cases = [
    ['Выгода в лизинг до 500 000 ₽', null],
    ['Ежемесячный платёж от 25 000 ₽. Выгода до 200 000 ₽', 200000],
    ['Скидка 10% на КАСКО', null],
    ['Выгода до 15%', null],
    ['Выгода до 1,2 млн ₽', 1200000],
    ['Выгода до 300 тыс. ₽', 300000],
    ['Выгода до 300 000 ₽*\n* предложение действует до 31.12.2026', 300000],
    ['Выгода 2025 года выпуска до 400 000 ₽', 400000],
    ['Цена с учётом выгоды от 2 199 000 ₽', null],
    ['Звоните 8 800 555 35 35, выгода до 100 000 ₽', 100000],
    ['Скидка на ТО 5 000 ₽', null],
    ['Скидка на КАСКО 20 000 ₽', null],
    ['Выгода до 300 000 ₽ при покупке с КАСКО', 300000],
    ['ВЫГОДА ДО 350 000 РУБ.', 350000],
    ['Выгода: от 50 000 до 300 000 ₽', 300000],
    ['Выгода до 300 000 ₽ на маркетплейсе', null],
    ['Выгода до 3 000 000 000 ₽', null],
  ];
  for (const [text, want] of cases) assert.equal(max(text), want, text);
});

import { extractPromoLines, diffLines, decideChange as decide } from './lib.mjs';
import test2 from 'node:test';
import assert2 from 'node:assert/strict';

test2('extractPromoLines: берёт акции и цены, пропускает таймеры и мусор', () => {
  const text = 'Меню\nВыгода до 300 000 ₽ на все модели\nДо конца акции осталось 3 дня\nМодель от 2 199 000 ₽\nВыгода до 300 000 ₽ на все модели\nО компании';
  assert2.deepEqual(extractPromoLines(text), ['Выгода до 300 000 ₽ на все модели', 'Модель от 2 199 000 ₽']);
});

test2('diffLines и decideChange: сравнение по тексту', () => {
  assert2.deepEqual(diffLines(['а акция 1 ₽ от 100'], ['а акция 1 ₽ от 100']), []);
  assert2.deepEqual(diffLines(['старая скидка'], ['новая скидка']), ['Добавилось: новая скидка', 'Пропало: старая скидка']);
  const site = { status: 'needs_check', text_mode: true, promo_lines: ['новая скидка'] };
  assert2.equal(decide(site, { promo_lines: ['старая скидка'] }).change, 'Изменилось');
  assert2.equal(decide(site, { promo_lines: ['новая скидка'] }).change, 'Не изменилось');
  assert2.equal(decide(site, null).change, 'Первая проверка');
});

test('«по выгодной цене» — не выгода', () => {
  assert.deepEqual(parseBenefits('Chery Tiggo 4 по выгодной цене 1 890 000 ₽'), []);
  assert.deepEqual(parseBenefits('Выгода до 250 000 ₽, выгодное предложение 1 990 000 ₽'), [250000]);
});

test('выгоды по моделям из сносок и баннеров', async () => {
  const { benefitsByModel } = await import('./lib.mjs');
  const text = [
    'CHERY TIGGO 9',
    'ВЫГОДА ПО ТРЕЙД-ИН ДО 600 000 ₽*',
    'Выгода в размере 150 000 рублей указана для автомобилей «Geely Coolray» (все комплектации).',
    'Цена на модель TANK (ТЭНК) 400 в комплектации Премиум с учетом прямой выгоды в 250 000 рублей, выгоды по трейд-ин в 250 000 рублей. Цена на модель TANK 300 с учетом выгоды по трейд-ин в 200 000 рублей.',
    'Belgee X50, Belgee X70 и Belgee S50 — выгода до 300 000 ₽.',
    'Выгода 500 000 ₽ при сдаче авто, кредит от 300 000 ₽',
  ].join('\n');
  const got = benefitsByModel(text, ['TIGGO 9', 'COOLRAY', '400', '300', 'X50', 'X70', 'S50']);
  assert.equal(got.get('TIGGO 9'), 600000);
  assert.equal(got.get('COOLRAY'), 150000);
  assert.equal(got.get('400'), 500000, 'прямая + трейд-ин складываются');
  assert.equal(got.get('300'), 200000);
  assert.equal(got.has('X50'), false);
});

test('итоговая выгода: части одной фразы складываются, разные блоки — нет', async () => {
  const { benefitTotal } = await import('./lib.mjs');
  assert.equal(benefitTotal('Цена на модель TANK 400 в комплектации Премиум 2026 года выпуска с учетом прямой выгоды в 250 000 рублей, с учетом выгоды по трейд-ин в 250 000 рублей, с учетом дополнительной выгоды по лояльному трейд-ин в 200 000 рублей при сдаче. Ставка 5%'), 700000);
  assert.equal(benefitTotal('с учётом выгоды по программе Трейд-ин в 300 000 рублей и прямой выгоды в 150 000 рублей.'), 450000);
  assert.equal(benefitTotal('Выгода до 500 000 ₽ | Трейд-ин: выгода до 300 000 ₽'), 500000);
  assert.equal(benefitTotal('Выгода до 500 000 ₽, в том числе выгода по трейд-ин 300 000 ₽'), 500000);
  assert.equal(benefitTotal('Цена на TANK 400 Премиум с учетом выгоды 250 000 рублей, цена на TANK 400 Люкс с учетом выгоды 300 000 рублей.'), 300000);
  assert.equal(benefitTotal('Выгода 200 000 ₽.\nВыгода 200 000 ₽.'), 200000);
  assert.equal(benefitTotal('Выгода 150 000 ₽ на Coolray, выгода в размере 150 000 рублей указана для всех комплектаций'), 150000, 'одна выгода дважды');
  assert.equal(benefitTotal('Выгода до\n455 000 ₽'), 455000, 'сумма на следующей строке');
  assert.equal(benefitTotal('Выгода до 500 000 ₽ | Прямая выгода 300 000 ₽ | Трейд-ин: выгода до 300 000 ₽'), 600000);
  assert.equal(benefitTotal('Кредит от 5%'), null);
});
