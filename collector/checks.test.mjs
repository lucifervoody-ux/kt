import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEALTH, KONGET, detectEngine, findTokens, healthVerdict, kongetVerdict,
} from './checks.mjs';
import { buildSheets, parseSites, placeColumns, sheetValues } from './sheet.mjs';
import { letter } from './export.mjs';
import { sheetIdFrom } from './google.mjs';
import { host } from './common.mjs';

const LIVE = 'Официальный дилер. Модели, цены, тест-драйв, кредит, трейд-ин, сервис и запчасти. '.repeat(3);

test('сайт работает, медленный, сломан или заглушка', () => {
  assert.equal(healthVerdict({ status: 200, seconds: 2, text: LIVE, title: 'Дилер' }).health, HEALTH.ok);
  assert.equal(healthVerdict({ status: 200, seconds: 14, text: LIVE, title: 'Дилер' }).health, HEALTH.slow);
  assert.equal(healthVerdict({ status: 503, seconds: 1, text: LIVE, title: 'Дилер' }).health, HEALTH.down);
  assert.equal(healthVerdict({ error: 'net::ERR_NAME_NOT_RESOLVED' }).health, HEALTH.down);
  assert.equal(healthVerdict({ error: 'page.goto: Timeout 30000ms exceeded.' }).health, HEALTH.manual);
  assert.equal(healthVerdict({ status: 200, seconds: 1, text: '', title: 'Дилер' }).health, HEALTH.manual);
  assert.equal(healthVerdict({ status: 200, seconds: 1, title: 'Дилер', text: `Web Page Blocked! The page cannot be displayed. ${LIVE}` }).health, HEALTH.manual);
  assert.equal(healthVerdict({ status: 200, seconds: 1, title: 'Дилер', text: `Сайт находится в разработке. ${LIVE}` }).health, HEALTH.stub);
  assert.equal(healthVerdict({ status: 200, seconds: 1, title: 'Домен example.ru продаётся', text: LIVE }).health, HEALTH.stub);
});

test('редирект на другой домен не ошибка, страница без заголовка просит проверить вручную', () => {
  const ok = { status: 200, seconds: 1, text: LIVE, title: 'Дилер' };
  assert.equal(healthVerdict({ ...ok, site: 'a.agat-group.com', finalUrl: 'https://xn--80aai5d.xn--p1ai/' }).health, HEALTH.ok);
  assert.equal(healthVerdict({ ...ok, site: 'lada42.ru', finalUrl: 'https://www.lada42.ru/' }).health, HEALTH.ok);
  assert.equal(healthVerdict({ ...ok, title: '' }).health, HEALTH.manual);
});

test('токен Конгет в разных записях', () => {
  assert.deepEqual(findTokens('//app.konget.ru/inject?token=538e1215043c412b9cfcff11319094a9'), ['538e1215043c412b9cfcff11319094a9']);
  assert.deepEqual(findTokens('https://app.konget.ru/widget.js?injectToken=1234567890'), ['1234567890']);
  assert.deepEqual(findTokens('window.konget = { inject_token: "abc123def456" }'), ['abc123def456']);
  assert.deepEqual(findTokens('нет токена'), []);
});

const NORMAL = '<html><head><script async src="//app.konget.ru/inject?token=538e1215043c412b9cfcff11319094a9"></script></head></html>';
const DELAYED = `<script>
setTimeout(() => {
var injectNode = document.createElement('script');
injectNode.src = 'https://app.konget.ru/inject?token=0a0afb6279544778af6346554dafb6f5';
injectNode.async = true;
document.body.appendChild(injectNode);
}, 9000);
</script>`;
const GTM = '<script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC123"></script>';

test('итог проверки скрипта Конгет', () => {
  const normal = kongetVerdict({ html: NORMAL });
  assert.equal(normal.konget, KONGET.ok);
  assert.equal(normal.kind, 'обычный');
  assert.deepEqual(normal.tokens, ['538e1215043c412b9cfcff11319094a9']);

  const delayed = kongetVerdict({
    html: DELAYED,
    dom: `${DELAYED}<script src="https://app.konget.ru/inject?token=0a0afb6279544778af6346554dafb6f5"></script>`,
    requests: ['https://app.konget.ru/inject?token=0a0afb6279544778af6346554dafb6f5'],
  });
  assert.equal(delayed.konget, KONGET.ok);
  assert.equal(delayed.kind, 'отложенный');
  assert.deepEqual(delayed.tokens, ['0a0afb6279544778af6346554dafb6f5']);

  const viaGtm = kongetVerdict({ html: GTM, requests: ['https://app.konget.ru/inject?token=1111aaaa2222bbbb'] });
  assert.equal(viaGtm.konget, KONGET.ok);
  assert.equal(viaGtm.kind, 'через контейнер');

  assert.equal(kongetVerdict({ html: GTM }).konget, KONGET.manual);
  assert.equal(kongetVerdict({ html: '<html>дилер</html>' }).konget, KONGET.missing);
  assert.equal(kongetVerdict({ html: '<script src="//app.konget.ru/inject"></script>' }).konget, KONGET.noToken);
  assert.equal(kongetVerdict({ html: NORMAL, expected: '538e1215043c412b9cfcff11319094a9' }).konget, KONGET.ok);
  assert.equal(kongetVerdict({ html: NORMAL, expected: '111' }).konget, KONGET.wrong);
  assert.equal(kongetVerdict({ error: 'Timeout' }).konget, KONGET.down);
});

test('листы таблицы: сводка по сайтам, проблемные сверху', () => {
  const base = { company: 'ООО Авто', brand: 'Tenet' };
  const sheets = buildSheets({
    health: { checked_at: '2026-10-30T07:00:00Z', sites: [{ id: 1, site: 'a.ru', ...base, health: 'Работает' }, { id: 2, site: 'b.ru', ...base, health: 'Не работает', reason: 'Таймаут' }] },
    konget: { checked_at: '2026-10-27T04:00:00Z', sites: [{ id: 1, site: 'a.ru', ...base, konget: 'Скрипт есть', tokens: ['123456'] }] },
    utp: {
      checked_at: '2026-10-29T07:00:00Z',
      sites: [{ id: 1, site: 'a.ru', ...base, change: 'Изменилось', changes: ['T8: цена'], models: [{ model: 'T8', price: 2899000, max_benefit: '-' }] }],
    },
  });
  assert.deepEqual(Object.keys(sheets), ['Сводка', 'Сайты и скрипт', 'УТП']);
  const rows = (name) => sheetValues(sheets[name]);
  assert.equal(rows('Сводка')[0][0], 'ID');
  assert.equal(rows('Сводка')[1][2], 'b.ru');
  assert.deepEqual(rows('Сводка')[2].slice(5, 9), ['Работает', 'Скрипт есть', 'Изменилось', 'T8: цена']);
  assert.ok(!JSON.stringify(sheets).includes('123456'), 'сам токен в таблицу не пишем');
  assert.deepEqual(rows('УТП')[1].slice(1, 7), ['a.ru', 'Tenet', 'Изменилось', 'Да', 'T8: цена', '']);
  assert.equal(rows('УТП').length, 2, 'одна строка — один сайт');
  assert.ok(!rows('Сводка')[0].includes('Токен есть'));
  assert.equal(rows('Сайты и скрипт')[1][5], 'Скрипт есть');
  for (const spec of Object.values(sheets)) assert.ok(spec.rows.every((r) => r.length === spec.columns.length));
});

test('выгрузка пишет в колонки человека по заголовкам и выбирает значения из его списков', () => {
  const spec = {
    columns: [{ title: 'ID' }, { title: 'Сайт' }, { title: 'Статус' }, { title: 'Изменения' }, { title: 'Пояснение' }],
    rows: [[1, 'a.ru', 'Токен не тот', 'Да', 'x'], [2, 'b.ru', 'Скрипт есть', 'Нет', '']],
  };
  const headers = ['ID', 'Сайт', 'Своя колонка', 'Статус на 2026-10-29', 'Изменения есть'];
  const lists = [[], [], [], ['Скрипт есть', 'Проверить вручную', 'Скрипта нет'], ['Да', 'Нет']];
  const { placed, missing, unknown } = placeColumns(spec, headers, lists);
  assert.deepEqual(placed.map((p) => p.index), [0, 1, 3, 4]);
  assert.deepEqual(placed[2].values, ['Проверить вручную', 'Скрипт есть']);
  assert.deepEqual(missing, ['Пояснение']);
  assert.deepEqual(unknown, []);
  assert.deepEqual(placeColumns({ columns: [{ title: 'Статус' }], rows: [['Новое']] }, ['Статус'], [['А']]).unknown, ['Статус: Новое']);
  assert.deepEqual([0, 25, 26, 27].map(letter), ['A', 'Z', 'AA', 'AB']);
});

test('движок сайта', () => {
  assert.equal(detectEngine('<div class="perxis-auto-1_27_0-col">'), 'Perxis');
  assert.equal(detectEngine('<script src="/bitrix/js/main/core.js">'), '1С-Битрикс');
  assert.equal(detectEngine('<link href="https://static.tildacdn.com/css/tilda-grid.css">'), 'Tilda');
  assert.equal(detectEngine('<meta name="generator" content="UMI.CMS">'), 'UMI.CMS');
  assert.equal(detectEngine('<html>просто сайт</html>'), 'Не определён');
  assert.equal(detectEngine('<script src="//script.tradedealer.ru/a.js">'), 'TradeDealer');
  assert.equal(detectEngine('', 'https://srt.agat.lada.ru/'), 'Сайты LADA');
  assert.equal(detectEngine('<img src="https://img.perxis.ru/unsafe/1920x0/filters">'), 'Perxis');
});

test('id таблицы из ссылки', () => {
  assert.equal(sheetIdFrom('https://docs.google.com/spreadsheets/d/1AbC-dEf_123/edit#gid=0'), '1AbC-dEf_123');
  assert.equal(sheetIdFrom(' 1AbC-dEf_123 '), '1AbC-dEf_123');
});

test('лист «Сайты»: читаем строки, пропускаем пустые и выключенные помечаем', () => {
  const sites = parseSites([
    ['ID', 'Компания', 'Сайт', 'Бренд', 'Ответственный', 'Проверять', 'Токен Конгет'],
    ['101', 'ООО Авто', 'https://dealer.ru/', 'Tenet', 'Иван', 'Да', '538e1215043c412b9cfcff11319094a9'],
    ['', 'без id', 'x.ru'],
    ['102', 'Без адреса', ''],
    ['103', 'Выкл', 'off.ru', 'KGM', '', 'Нет'],
    ['104', 'Коротко', 'short.ru'],
    ['101', 'Дубль', 'dup.ru'],
  ]);
  assert.deepEqual(sites.map((s) => s.id), [101, 103, 104]);
  assert.equal(sites[0].site, 'https://dealer.ru');
  assert.equal(sites[0].konget_token, '538e1215043c412b9cfcff11319094a9');
  assert.equal(sites[1].active, false);
  assert.equal(sites[2].active, true);
  // Колонку «Токен Конгет» удалили, «None» — то же, что пусто.
  const [short] = parseSites([['ID', 'Компания', 'Сайт', 'Проверять', 'Заметки'], ['7', 'None', 'x.ru', 'Да', 'заметка']]);
  assert.deepEqual([short.company, short.konget_token, short.active], ['', '', true]);
});

test('сценарий подходит к сайту из таблицы, только если адрес тот же', () => {
  assert.equal(host('https://www.Tenet.ru/models/'), 'tenet.ru');
  assert.equal(host('tenet.ru'), host('http://tenet.ru'));
  assert.notEqual(host('tenet.ru'), host('tenet-avtoruss.ru'));
});

test('сайты, не прошедшие проверку работы, пропускаются до ручной проверки', async () => {
  const { splitUnverified } = await import('./common.mjs');
  const health = { sites: [
    { id: 1, site: 'a.ru', health: 'Не работает' }, { id: 2, site: 'b.ru', health: 'Проверить вручную' },
    { id: 3, site: 'c.ru', health: 'Работает' }, { id: 4, site: 'd.ru', health: 'Не работает' },
  ] };
  const { run, skipped } = splitUnverified([
    { id: 1, site: 'a.ru' }, { id: 2, site: 'b.ru', verified: true }, { id: 3, site: 'c.ru' }, { id: 4, site: 'другой.ru' },
  ], health);
  assert.deepEqual(run.map((s) => s.id), [2, 3, 4]);
  assert.deepEqual(skipped.map((s) => s.site.id), [1]);
  assert.equal(parseSites([['ID', 'Сайт', 'Проверено вручную'], ['1', 'a.ru', 'Да']])[0].verified, true);
});

test('в «Сводке» нет «Токен есть: Нет» у закрытых сайтов и дублей причины', () => {
  const site = { id: 1, site: 'a.ru' };
  const { 'Сводка': sum } = buildSheets({
    health: { sites: [{ ...site, health: HEALTH.down, reason: 'ERR_NAME_NOT_RESOLVED' }] },
    konget: { sites: [{ ...site, konget: KONGET.down, tokens: [], reason: 'ERR_NAME_NOT_RESOLVED' }] },
    utp: { sites: [] },
  });
  assert.equal(sum.rows[0][7], '');
  assert.equal(sum.rows[0][9], 'ERR_NAME_NOT_RESOLVED');
});

test('шаблоны движков читаются и у каждого есть движок', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { load } = await import('js-yaml');
  const dir = path.join(import.meta.dirname, '..', 'templates');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  assert.ok(files.length >= 4);
  for (const f of files) assert.ok(load(fs.readFileSync(path.join(dir, f), 'utf8')).engine, f);
});

test('ИИ: принимаем только числа, которые есть на странице', async () => {
  const { parseAiAnswer, askAi, trimPageText } = await import('./ai.mjs');
  const page = 'TIGGO 9 от 3 635 000 ₽\nВыгода до 500 000 ₽\nARRIZO 8 от 2 499 000 ₽';
  const answer = '```json\n[{"model":"TIGGO 9","price":3635000,"max_benefit":500000},'
    + '{"model":"ARRIZO 8","price":2499000,"max_benefit":900000},{"model":"Выдумка","price":4100000,"max_benefit":null},'
    + '{"model":"Платёж","price":25000,"max_benefit":null}]\n```';
  assert.deepEqual(parseAiAnswer(answer, page), [
    { model: 'TIGGO 9', price: 3635000, max_benefit: 500000 },
    { model: 'ARRIZO 8', price: 2499000, max_benefit: '-' },
  ]);
  assert.deepEqual(parseAiAnswer('нет моделей', page), []);
  const fake = async (url, init) => {
    assert.match(url, /chat\/completions$/);
    assert.equal(JSON.parse(init.body).model, 'm1');
    return { ok: true, json: async () => ({ choices: [{ message: { content: answer } }] }) };
  };
  const got = await askAi({ brand: 'Chery', site: 'a.ru', pageText: page }, { env: { AI_API_KEY: 'k', AI_MODEL: 'm1' }, fetchImpl: fake });
  assert.equal(got.length, 2);
  assert.ok(trimPageText('Меню\nTIGGO 9 от 3 635 000 ₽').includes('3 635 000'));
});

test('ИИ: выбор бесплатных моделей OpenRouter и переход к следующей при ошибке', async () => {
  const { pickFreeModels, askAi } = await import('./ai.mjs');
  const list = [
    { id: 'a/small:free', context_length: 8000 }, { id: 'x/paid', context_length: 100000 },
    { id: 'google/gemini-2.0-flash:free', context_length: 1000000 }, { id: 'meta/llama-3.3-70b:free', context_length: 128000 },
    { id: 'z/other:free', context_length: 200000 },
  ];
  assert.deepEqual(pickFreeModels(list), ['google/gemini-2.0-flash:free', 'meta/llama-3.3-70b:free', 'z/other:free']);
  const page = 'TIGGO 9 от 3 635 000 ₽';
  const used = [];
  const fake = async (url, init) => {
    if (url.endsWith('/models')) return { ok: true, json: async () => ({ data: list }) };
    const model = JSON.parse(init.body).model;
    used.push(model);
    if (used.length === 1) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '[{"model":"TIGGO 9","price":3635000,"max_benefit":null}]' } }] }) };
  };
  const got = await askAi({ brand: 'Chery', site: 'a.ru', pageText: page }, { env: { AI_API_KEY: 'k', AI_BASE_URL: 'https://openrouter.ai/api/v1' }, fetchImpl: fake });
  assert.equal(got[0].price, 3635000);
  assert.deepEqual(used, ['google/gemini-2.0-flash:free', 'meta/llama-3.3-70b:free']);
});

test('ИИ: адрес OpenRouter определяется по ключу', async () => {
  const { baseUrl } = await import('./ai.mjs');
  assert.equal(baseUrl({ AI_API_KEY: 'sk-or-v1-abc' }), 'https://openrouter.ai/api/v1');
  assert.equal(baseUrl({ AI_API_KEY: 'x', AI_BASE_URL: 'https://a.b/v1/' }), 'https://a.b/v1');
  assert.match(baseUrl({ AI_API_KEY: 'AIza' }), /generativelanguage/);
});

test('«Проверять УТП: Нет» отключает только УТП, сайт остаётся активным', () => {
  const [off, on, none] = parseSites([
    ['ID', 'Сайт', 'Проверять', 'Проверять УТП'],
    ['1', 'a.ru', 'Да', 'Нет'],
    ['2', 'b.ru', 'Да', 'Да'],
    ['3', 'c.ru', 'Да', ''],
  ]);
  assert.equal(off.active, true);
  assert.equal(off.utp, false);
  assert.equal(on.utp, true);
  assert.equal(none.utp, true);
});

test('шапка ищется в первых строках, данные не выше строки 3', async () => {
  const { findHeaderRow, FIRST_DATA_ROW } = await import('./sheet.mjs');
  assert.equal(FIRST_DATA_ROW, 3);
  assert.equal(findHeaderRow([[], ['', 'ID', 'Сайт', 'Статус']], ['ID', 'Сайт']), 1);
  assert.equal(findHeaderRow([['', 'ID', 'Сайт']], ['ID', 'Сайт']), 0);
  assert.equal(findHeaderRow([['x'], ['y']], ['ID', 'Сайт']), -1);
  const sites = parseSites([[], ['', 'ID', 'Сайт', 'Проверять'], ['', '5', 'a.ru', 'Да']]);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].id, 5);
});

test('проверка работы: 403 — защита, редирект на другой домен — не ошибка', async () => {
  const { healthVerdict, kongetVerdict, HEALTH, KONGET } = await import('./checks.mjs');
  const page = { title: 'Сайт', text: 'текст '.repeat(40), seconds: 1 };
  assert.equal(healthVerdict({ ...page, status: 403 }).health, HEALTH.manual);
  assert.equal(healthVerdict({ ...page, status: 404 }).health, HEALTH.down);
  const redirect = healthVerdict({ ...page, status: 200, site: 'a.agat-group.com', finalUrl: 'https://xn--80aai5d.xn--p1ai/' });
  assert.equal(redirect.health, HEALTH.ok);
  assert.match(redirect.reason, /Перенаправляет/);
  assert.equal(kongetVerdict({ html: '<html>403</html>', dom: '', status: 403 }).konget, KONGET.manual);
  assert.equal(kongetVerdict({ html: '<html>ok</html>', dom: '', status: 200 }).konget, KONGET.missing);
});

test('движки Каскад и УАЗ-дилер определяются по коду страницы', () => {
  assert.equal(detectEngine('<style>:root{--siteUi: kaskad}</style><script src="/_nuxt/a.js"></script>', 'https://x.ru/'), 'Каскад');
  assert.equal(detectEngine('<div class="main-cars-nav-item"></div><script src="/_nuxt/a.js"></script>', 'https://x.ru/'), 'УАЗ-дилер');
  assert.equal(detectEngine('<script src="/_nuxt/a.js"></script>', 'https://x.ru/'), 'Nuxt');
});

test('просроченный сертификат — понятная причина', () => {
  const v = healthVerdict({ error: 'page.goto: net::ERR_CERT_DATE_INVALID at https://x.ru/' });
  assert.equal(v.health, HEALTH.manual);
  assert.match(v.reason, /просрочен/);
});

test('одно открытие сайта даёт доступность и отложенный скрипт', async () => {
  const { checkSite } = await import('./health.mjs');
  const calls = [];
  let onRequest;
  const url = 'https://dealer.example';
  const page = {
    on: (event, listener) => { if (event === 'request') onRequest = listener; },
    goto: async () => { calls.push('goto'); return { status: () => 200, text: async () => GTM }; },
    waitForLoadState: async () => {}, waitForFunction: async () => {},
    evaluate: async () => LIVE, content: async () => GTM, title: async () => 'Дилер', url: () => url,
    waitForTimeout: async () => onRequest({ url: () => 'https://app.konget.ru/inject?token=12345678' }),
  };
  const browser = { newContext: async () => ({ newPage: async () => page, close: async () => calls.push('close') }) };
  const raw = await checkSite(browser, { site: url });
  assert.equal(healthVerdict(raw).health, HEALTH.ok);
  assert.equal(kongetVerdict(raw).konget, KONGET.ok);
  assert.deepEqual(calls, ['goto', 'close']);
});

test('таймаут, заглушка и медленный сайт получают отдельное пояснение', async () => {
  const { openingResult } = await import('./sheet.mjs');
  assert.deepEqual(openingResult(HEALTH.manual, 'Таймаут'), ['Проверить вручную', 'Ручная проверка. Таймаут']);
  assert.deepEqual(openingResult(HEALTH.ok), ['Работает', 'Страница открылась']);
  assert.deepEqual(openingResult(HEALTH.slow, 'Открывался 12 с'), ['Работает', 'Открывался 12 с']);
  assert.deepEqual(openingResult(HEALTH.stub), ['Не работает', 'Вместо сайта показана заглушка']);
});

test('проверка Конгет учитывает только настоящий адрес скрипта', () => {
  assert.equal(kongetVerdict({ requests: ['https://dealer.ru/?next=konget'] }).konget, KONGET.missing);
  assert.equal(kongetVerdict({ html: '<script src="//app.konget.ru/inject?src=dealer&amp;token=abc123"></script>' }).konget, KONGET.ok);
});

test('выгрузка учитывает текущий реестр, адрес и разрешение на УТП', () => {
  const registry = [
    { id: 1, site: 'new.ru', active: true, utp: true },
    { id: 2, site: 'disabled.ru', active: false, utp: true },
    { id: 3, site: 'site.ru', active: true, utp: false },
  ];
  const sheets = buildSheets({ registry,
    health: { sites: [{ id: 1, site: 'old.ru', health: HEALTH.ok }, { id: 2, site: 'disabled.ru', health: HEALTH.ok }] },
    konget: { sites: [{ id: 1, site: 'old.ru', konget: KONGET.ok }] },
    utp: { sites: [{ id: 3, site: 'site.ru', change: 'Изменилось' }] },
  });
  assert.deepEqual(sheets['Сводка'].rows.map((r) => [r[0], r[2], r[5], r[6], r[7]]), [
    [1, 'new.ru', '', '', ''], [3, 'site.ru', '', '', ''],
  ]);
  assert.equal(sheets['Сайты и скрипт'].rows.length, 0);
  assert.equal(sheets['УТП'].rows.length, 0);
});
