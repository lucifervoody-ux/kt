// Кнопка 2 «Сверить УТП». Запускается на GitHub (Actions) по кнопке в приложении
// или у себя командой: npm run collect   (один сайт: npm run collect -- --site 1)
//
// Что делает:
// 1. Берёт список сайтов из листа «Сайты» Google-таблицы, подсказки по сайту — из scenarios/<id>.
// 2. Открывает страницы сайта в браузере и берёт модели, цены и выгоды по сценарию.
// 3. Сравнивает с прошлым сбором и пишет итог в data/utp/latest.json и data/utp/history/<дата>.json.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  SKIP_REASON, host, loadSites, previousOf, siteUrl, splitUnverified,
} from './common.mjs';
import { BLOCKED, detectEngine } from './checks.mjs';
import { modelRoute, profileRows, sameSite } from './site-profile.mjs';
import { atomOffers, labelledOffers, reconcileOffers, explicitPrices } from './offers.mjs';
import { findModelCards } from './autocards.mjs';
import { aiConfigured, askAi, trimPageText } from './ai.mjs';
import { load as loadYaml } from 'js-yaml';
import {
  MIN_PRICE, MAX_PRICE, CHANGE, benefitTotal, benefitsByModel, parsePrices, parseBenefits, parseAmounts, cleanModel, modelKey, mergeModels, validateModels, decideChange, sortSites, summarize, assertUniqueIds, historyToDelete,
} from './lib.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const UTP = path.join(DATA, 'utp');
const HISTORY = path.join(UTP, 'history');
const SCREENS = path.join(DATA, 'screens');
const PAGE_TIMEOUT = 45_000;
const PARALLEL = Number(process.env.PARALLEL) || 6; // сколько сайтов проверять одновременно

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

function isVehiclePrice(text) {
  return /^\s*(?:цена\s*[:—-]?\s*)?(?:от\s*)?\d[\d\s.,]*\s*(?:₽|руб\.?|рублей|рубля|р\.)?\s*[*¹²³]*\s*$/i.test(text);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Прошлый сбор: последний завершённый полный сбор, включая сегодняшний.
function loadPrevious(today) {
  const latest = readJson(path.join(UTP, 'latest.json'));
  if (latest?.date <= today && !latest.stopped && !latest.partial && latest.sites?.length) return latest;
  if (!fs.existsSync(HISTORY)) return null;
  const dates = fs.readdirSync(HISTORY).map((f) => f.replace('.json', '')).filter((d) => d < today).sort();
  return dates.length ? readJson(path.join(HISTORY, `${dates.at(-1)}.json`)) : null;
}

// Открывает страницу и выполняет шаги сценария: нажать кнопки, подождать, прокрутить.
async function openPage(context, site, url, cfg = {}) {
  if (site.expired) throw new Error('Истекло время проверки сайта');
  site.pagesOpened = (site.pagesOpened || 0) + 1;
  const page = await context.newPage();
  // Навигация может получить заголовки, но бесконечно ждать окончания ответа.
  // Ограничение действует и во время чтения тела, прокрутки и съёмки страницы.
  const deadline = setTimeout(() => page.close({ reason: 'Истекло время проверки страницы' }).catch(() => {}), PAGE_TIMEOUT * 2);
  page.once('close', () => clearTimeout(deadline));
  let sourceText = '';
  try {
    if (!sameSite(url, siteUrl(site))) throw new Error('Ссылка ведёт на другой домен');
    const response = await page.goto(url, { waitUntil: 'commit', timeout: PAGE_TIMEOUT });
    if (!sameSite(page.url(), siteUrl(site))) throw new Error('Сайт перенаправил на другой домен');
    if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
    if (!new URL(url).pathname.replace(/\//g, '') && !site.sourceText && response && sameSite(response.url(), siteUrl(site))) {
      const html = await response.text().catch(() => '');
      if (html) sourceText = await page.evaluate(markup => {
        const doc = new DOMParser().parseFromString(markup, 'text/html');
        doc.querySelectorAll('script,style,noscript,svg,template').forEach(el => el.remove());
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
        const lines = [];
        while (walker.nextNode()) {
          const line = walker.currentNode.textContent.replace(/\s+/g, ' ').trim();
          if (line) lines.push(line);
        }
        return lines.join('\n');
      }, html).catch(() => '');
    }
  } catch (e) {
    await page.close();
    throw e;
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
  await page.waitForFunction(() => (document.body?.innerText || '').trim().length >= 80, null, { timeout: 8000 }).catch(() => {});
  {
    const visible = await page.evaluate(() => document.title + '\n' + (document.body?.innerText || '').slice(0, 2000)).catch(() => '');
    if (!sameSite(page.url(), siteUrl(site)) || BLOCKED.test(visible)) {
      await page.close();
      throw new Error('Страница дилера недоступна для проверки');
    }
  }
  if (sourceText) site.sourceText = sourceText;
  for (const sel of cfg.click || []) {
    await page.click(sel, { timeout: 5_000 }).catch(() => log(`  [${site.id}] не нашёл кнопку ${sel}`));
  }
  if (cfg.wait_for) await page.waitForSelector(cfg.wait_for, { timeout: 15_000 }).catch(() => {});
  if (cfg.scroll) await autoScroll(page);
  if (new URL(url).pathname === '/') {
    if (!site.offerCards?.length) {
      site.offerCards = await page.locator('.t-rec').evaluateAll(cards => cards.map(card =>
        [...card.querySelectorAll('.tn-atom')].map(el => el.textContent.trim()).filter(Boolean)
      )).catch(() => []);
    }
    const text = await page.locator('body').innerText({timeout: 3000}).catch(() => '');
    if (text.length > (site.visibleText || '').length) site.visibleText = text;
  }
  return page;
}

// Снимок и код страницы: по ним видно, где на сайте цены, и можно дописать сценарий.
async function snapshot(page, site, name) {
  fs.mkdirSync(path.join(SCREENS, String(site.id)), { recursive: true });
  const screen = `data/screens/${site.id}/${name}.jpg`;
  const captured = await page.screenshot({ path: path.join(ROOT, screen), fullPage: true, type: 'jpeg', quality: 50, timeout: 10000 })
    .then(() => true, () => false);
  fs.writeFileSync(path.join(SCREENS, String(site.id), `${name}.html`), await page.content());
  return captured ? screen : null;
}

// Одна страница сайта: открыть, выполнить шаги сценария, собрать карточки моделей.
async function collectPage(context, site, pageCfg, index) {
  const page = await openPage(context, site, pageCfg.url, pageCfg);
  try {

    const hasSelectors = Boolean(pageCfg.profile || pageCfg.auto || (pageCfg.card && (pageCfg.model || pageCfg.model_name)));
    let rows = [];
    if (pageCfg.profile) {
      rows = await page.evaluate(profileRows, pageCfg.profile);
    } else if (pageCfg.auto) {
      // Автопоиск карточек моделей без селекторов (collector/autocards.mjs).
      if (pageCfg.scroll !== false) await autoScroll(page);
      rows = await page.evaluate(findModelCards, { brand: site.brand || '' }).catch(() => []);
    } else if (hasSelectors) {
      rows = await page.$$eval(
        pageCfg.card,
        (cards, cfg) => cards.map((card) => {
          // innerText — текст как его видит человек; у скрытых блоков (например, меню) берём textContent.
          // Куски склеиваем через « | », чтобы соседние суммы «455 000» и «455 000» не слиплись в одно число.
          const text = (sel) => (sel ? [...card.querySelectorAll(sel)].map((e) => e.innerText || e.textContent).join(' | ') : '');
          // model_attr: название берём из атрибута (например, href ссылки), а не из текста.
          const model = cfg.modelAttr
            ? [...card.querySelectorAll(cfg.model)].map((e) => e.getAttribute(cfg.modelAttr) || '').join(' | ')
            : text(cfg.model);
          return { model, price: text(cfg.price), benefit: text(cfg.benefit) };
        }),
        { model: pageCfg.model, price: pageCfg.price, benefit: pageCfg.benefit, modelAttr: pageCfg.model_attr },
      );
    }

    // Снимок страницы нужен, если сценарий ещё не заполнен или ничего не нашлось:
    // по нему видно, где на сайте цены, и можно дописать сценарий.
    const screen = !hasSelectors || (!pageCfg.profile && rows.length === 0) ? await snapshot(page, site, index) : null;

    // model_map: когда на сайте вместо названия картинка, сопоставляем по коду модели из ссылки.
    const mapName = (raw) => {
      const hit = Object.entries(pageCfg.model_map || {}).find(([key]) => raw.includes(key));
      return hit ? hit[1] : raw;
    };
    const models = rows.map((r) => {
      r.model = pageCfg.model_name || mapName(r.model);
      // У лендингов в цену не берём суммы из фраз про выгоду, скидку, платёж и кредит: «с выгодой от 1 001 000 руб.» — не цена.
      const priceText = pageCfg.model_name || pageCfg.auto ? String(r.price).replace(/(выгод|скидк|экономи|кредит|рассрочк|платеж|платёж|первоначальн)(?:(?!цен)[^.\n|]){0,70}/gi, ' ') : r.price;
      const benefits = (pageCfg.benefit_all ? parseAmounts : parseBenefits)(r.benefit);
      // В автопоиске сумма выгоды («Выгода до | 455 000 ₽») может попасть и в цены: такие суммы из цен убираем.
      const prices = (pageCfg.strict_price && !isVehiclePrice(priceText) ? [] : (pageCfg.auto || pageCfg.model_name ? explicitPrices(priceText) : parsePrices(priceText))).filter((n) => n >= (pageCfg.min_price || 0) && !(pageCfg.auto && benefits.includes(n)));
      const price = prices.length ? Math.min(...prices) : '-';
      // Части одной фразы («прямая 250 000 + трейд-ин 250 000 + лояльная 200 000») складываем.
      let benefit = benefits.length ? (pageCfg.benefit_all ? Math.max(...benefits) : (benefitTotal(r.benefit) ?? Math.max(...benefits))) : '-';
      // Автопоиск: «цена с учётом выгоды 2 016 000 ₽» — это цена, а не выгода. Выгода в половину цены
      // и больше или выгода больше 1,2 млн без цены почти всегда такая ошибка: такую выгоду не пишем.
      if (pageCfg.auto && benefit !== '-' && price !== '-' && benefit > price) benefit = '-';
      return {
        model: cleanModel(r.model.split('\n').map((l) => l.trim()).find(Boolean), site.brand),
        price,
        max_benefit: benefit,
        source_url: pageCfg.url,
      };
    });
    return { models, screen, hasSelectors };
  } finally {
    await page.close();
  }
}

// Обход по моделям: со страницы-списка берём ссылки на все модели,
// заходим на страницу каждой и берём все цены и выгоды (по всем комплектациям).
// Цена модели — самая маленькая, выгода — самая большая.
async function collectModelPages(context, site, cfg) {
  const list = await openPage(context, site, cfg.list_url, cfg);
  let links;
  try {
    links = await list.$$eval(cfg.link, (els, nameSel) => els.map((a) => {
      const nameEl = nameSel ? a.querySelector(nameSel) : null;
      // Ближайший блок вокруг ссылки, где уже написана цена («TIVOLI от 3 095 000 ₽»).
      let n = a;
      let around = '';
      for (let i = 0; i < 5 && n; i += 1, n = n.parentElement) {
        if ([...n.querySelectorAll('a[href]')].some(other => other.pathname !== a.pathname)) break;
        const t = (n.innerText || '').replace(/\s+/g, ' ');
        if (/\d[\d\s\u00a0]{4,}\s*₽/.test(t)) { around = t; break; }
      }
      return { href: a.href, name: ((nameEl || a).innerText || (nameEl || a).textContent || '').trim(), around };
    }), cfg.name);
    // Меню в разметке сайта: "name": "T1 от 3 520 000 ₽", "url": "/models/t1".
    const html = await list.content();
    for (const m of html.matchAll(/"name":\s*"([^"]*?от[^"]*?₽)"\s*,\s*"url":\s*"([^"]+)"/g)) {
      links.push({ href: new URL(m[2], list.url()).href, name: '', around: m[1], onlyPrice: true });
    }
  } finally {
    await list.close();
  }
  // Одна и та же страница бывает в меню с разными хвостами: …/gs4?mobile, …/gs4?main_menu, …/gs4/.
  const seen = new Set();
  const key = (href) => href.split(/[?#]/)[0].replace(/\/+$/, '');
  // Цены моделей с самой главной: запасной путь, если на странице модели цены нет.
  // Одна модель бывает в меню с хвостом (?main_menu) и без: цену из адреса без хвоста считаем главной.
  const plainPrice = new Map();
  const menuPrice = new Map();
  const minPrice = (cfg.page || {}).min_price || 0;
  for (const l of links) {
    const prices = [...String(l.around || '').matchAll(/(?:цена\s*)?от\s+([\d .,]+)\s*(?:₽|руб|р\.)/gi)].flatMap(m => parsePrices(m[1])).filter((n) => n >= minPrice);
    // Блок с несколькими разными ценами — не карточка одной модели: такую цену не берём.
    if (cfg.routes && (!sameSite(l.href, cfg.list_url) || !modelRoute(l.href, cfg.routes))) continue;
    if (cfg.page?.strict_price && /плат[её]ж|в месяц|скидк|выгод|лизинг|взнос/i.test(l.around || '')) continue;
    if (!prices.length || (!l.onlyPrice && new Set(prices).size > 1)) continue;
    const target = /[?#]/.test(l.href) ? menuPrice : plainPrice;
    const k = key(l.href);
    target.set(k, Math.min(...prices, target.get(k) ?? Infinity));
  }
  const listPrice = { get: (k) => plainPrice.get(k) ?? menuPrice.get(k) };
  links = links.filter((l) => !l.onlyPrice && sameSite(l.href, cfg.list_url));
  if (cfg.routes) links = links.filter((l) => modelRoute(l.href, cfg.routes));
  links = links.filter((l) => l.href && !seen.has(key(l.href)) && seen.add(key(l.href)));
  if (!links.length) throw new Error(`На ${cfg.list_url} не нашлось ссылок на модели`);
  if (cfg.max_links) links = links.slice(0, cfg.max_links);
  log(`  [${site.id}] моделей в списке: ${links.length}`);

  const page = cfg.page || {};
  const hasSelectors = Boolean(page.price || page.benefit);
  const models = [];
  const screens = [];
  const notes = [];
  for (const [i, link] of links.entries()) {
    let p;
    try {
      p = await openPage(context, site, link.href, page);
      const found = await p.evaluate(({ price, benefit, title, trim, standalone_price }) => {
        const texts = (root, sel) => (sel ? [...root.querySelectorAll(sel)].map((e) => e.innerText || e.textContent) : []);
        const roots = trim ? [...document.querySelectorAll(trim)] : [document];
        return {
          title: texts(document, title)[0] || '',
          prices: roots.flatMap((r) => [
            ...texts(r, price),
            ...(standalone_price ? [...r.querySelectorAll(standalone_price)] : [])
              .filter(el => [...(el.closest('.td-card-widget__item')?.querySelectorAll('a[href]') || [])]
                .some(a => a.origin === location.origin && a.pathname.replace(/\/+$/, '') === location.pathname.replace(/\/+$/, '')))
              .map(el => el.innerText || el.textContent)
              .filter(t => /^\s*от\s+[\d\s]+\s*(?:₽|руб\.)[*¹\s]*$/iu.test(t)),
          ]),
          // Выгоды часто стоят отдельно от комплектаций, поэтому ищем их по всей странице.
          benefits: texts(document, benefit),
        };
      }, page);
      // min_price: отсекаем платежи и скидки, которые сайт показывает рядом с ценой (1 754 ₽, 50 000 ₽).
      const prices = found.prices.filter((value) => !page.strict_price || isVehiclePrice(value)).flatMap(parsePrices).filter((n) => n >= (page.min_price || 0));
      const benefits = found.benefits.flatMap(page.benefit_all ? parseAmounts : parseBenefits);
      // Текст ссылки «О модели» — не название: тогда берём его из адреса страницы (/models/gs3 → GS3).
      const generic = /^(о модели|подробнее|узнать больше|смотреть)$/i;
      const fromUrl = () => decodeURIComponent(new URL(link.href).pathname.split('/').filter(Boolean).at(-1) || '').replace(/[-_]+/g, ' ').toUpperCase();
      const raw = (found.title || link.name).split('\n').map((l) => l.trim()).find(Boolean) || '';
      const name = cleanModel(!raw || generic.test(raw) ? fromUrl() : raw, site.brand);
      // Снимок: если сценарий не дописан, или на странице модели не нашлось цены (один на сайт).
      if (!hasSelectors || (!prices.length && listPrice.get(key(link.href)) == null && !screens.length)) {
        const file = await snapshot(p, site, `model-${i}`);
        if (file) screens.push(file);
      }
      const fromList = listPrice.get(key(link.href));
      models.push({
        model: name,
        price: prices.length ? Math.min(...prices, fromList ?? Infinity) : (fromList ?? '-'),
        max_benefit: !benefits.length ? '-' : page.benefit_all ? Math.max(...benefits) : Math.max(...found.benefits.map((t) => benefitTotal(t) ?? 0)),
        source_url: link.href,
        modelDetail: !page.standalone_price,
      });
    } catch (e) {
      notes.push(`Не открылась ${link.href}: ${e.message.split('\n')[0]}`);
    } finally {
      await p?.close();
    }
  }
  return { models, screens, notes, hasSelectors };
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    const height = document.body.scrollHeight;
    for (let y = 0; y < height; y += Math.max(600, Math.ceil(height / 30))) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 150));
    }
  });
}

// Общие шаблоны по движкам (templates/*.yaml): для сайтов без своего сценария.
const TEMPLATES = path.join(ROOT, 'templates');
const templates = new Map(fs.existsSync(TEMPLATES)
  ? fs.readdirSync(TEMPLATES).filter((f) => /\.ya?ml$/.test(f)).map((f) => {
    const t = loadYaml(fs.readFileSync(path.join(TEMPLATES, f), 'utf8'));
    return [t.engine, t];
  })
  : []);
// Движок сайта из последней проверки «Работа сайтов» (тот же ID и тот же адрес).
const healthById = new Map((readJson(path.join(DATA, 'health', 'latest.json'))?.sites || []).map((s) => [String(s.id), s]));

// Шаблон движка с адресами этого сайта: «/» → https://сайт/.
function fromTemplate(site, t) {
  const abs = (u) => new URL(u, `${siteUrl(site)}/`).href;
  return {
    models: t.models && { ...t.models, list_url: abs(t.models.list_url) },
    pages: (t.pages || []).map((p) => ({ ...p, url: abs(p.url) })),
    aggregate: t.aggregate,
    auto: t.auto && { ...t.auto, url: abs(t.auto.url || '/') },
  };
}

const profiles = new Map(Object.entries(JSON.parse(fs.readFileSync(path.join(TEMPLATES, 'sites.json'), 'utf8')))
  .map(([address, profile]) => [host(address), profile]));

async function collectSite(browser, site) {
  const profile = profiles.get(host(site.site));
  if (profile) site.profile = profile;
  if (!site.pages?.length && !site.models) {
    const known = healthById.get(String(site.id));
    let engine = known && host(known.site) === host(site.site) ? known.engine : '';
    if (site.profile && site.profile.engine !== '*' && !templates.has(engine)) engine = site.profile.engine;
    if (!engine || !templates.has(engine)) {
      // Движок неизвестен или для него ещё нет шаблона: открываем главную, определяем движок
      // и сохраняем снимок — по нему можно сделать шаблон.
      const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1366, height: 900 }, ignoreHTTPSErrors: false });
      site.activeContext = context;
      try {
        const page = await openPage(context, site, siteUrl(site));
        engine = detectEngine(await page.content(), page.url());
        if (!templates.has(engine)) await snapshot(page, site, 'home');
      } catch {
        // Главная не открылась — ниже вернём «Нет сценария».
      } finally {
        await context.close();
      }
    }
    if (templates.has(engine)) {
      log(`  [${site.id}] своего сценария нет, беру шаблон движка ${engine}`);
      Object.assign(site, fromTemplate(site, templates.get(engine)), { template: engine });
    } else if (templates.has('*')) {
      log(`  [${site.id}] своего сценария и шаблона движка нет (${engine || 'движок неизвестен'}), беру запасной шаблон`);
      Object.assign(site, fromTemplate(site, templates.get('*')), { template: '*', engine });
    } else {
      site.engine = engine;
    }
  }
  if (site.profile) {
    const { card, routes, brand, priceAnchors, modelNames } = site.profile;
    if (card) {
      site.pages = [{ url: siteUrl(site), ...card, min_price: 300000, strict_price: true }, ...(site.pages || [])];
    }
    if (routes?.length && site.template !== 'УАЗ-дилер' && (!site.models || site.template === '*')) {
      site.models = {
        list_url: siteUrl(site), link: 'a[href]', routes, max_links: 35,
        page: { title: 'main h1, h1', price: '[itemprop="price"], [class*="price" i]:not([class*="old" i])',
          benefit: '[class*="benefit" i], [class*="discount" i]', min_price: 300000, strict_price: true },
      };
    }
    site.profileFields = { brand, priceAnchors, modelNames };
    // По общему тексту главной нельзя установить, к какой модели относится сумма.
    if (site.template === '*' && !routes?.length) delete site.models;
  }
  return collectSiteWith(browser, site);
}

async function collectSiteWith(browser, site) {
  const base = {
    id: site.id, company: site.company || '', responsible: site.responsible || '', site: site.site, brand: site.brand || '', file: site.file,
    models: [], screens: [], comment: '',
  };
  if (!site.pages?.length && !site.models && !site.auto && !site.aggregate) {
    const engine = site.engine ? ` (движок: ${site.engine})` : '';
    return { ...base, status: 'no_scenario', comment: `Для сайта ещё нет ни сценария, ни шаблона движка${engine}` };
  }
  const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1366, height: 900 }, ignoreHTTPSErrors: false });
  site.activeContext = context;
  try {
    const rows = [];
    const notes = [];
    let anyOpened = false;
    let unfinished = false;
    let autoUsed = false;
    // auto: сначала ищем карточки моделей на главной без селекторов; нашлись — обход моделей не нужен.
    if (site.profileFields && !site.profile.card && (!site.template || ['*', 'Tilda'].includes(site.template))) {
      try {
        const res = await collectPage(context, site, { url: siteUrl(site), profile: site.profileFields, min_price: 300000 }, 'profile');
        rows.push(...res.models);
        anyOpened = true;
      } catch (e) {
        notes.push(`Профиль домена: ${e.message.split('\n')[0]}`);
      }
    }
    if (site.auto && !site.profile?.card && !rows.length) {
      try {
        const res = await collectPage(context, site, { url: siteUrl(site), min_price: 600000, ...site.auto, auto: true }, 'auto');
        anyOpened = true;
        rows.push(...res.models);
        if (res.models.length) autoUsed = true;
        if (res.models.length) log(`  [${site.id}] автопоиск нашёл карточки моделей: ${res.models.length}`);
      } catch (e) {
        notes.push(`Автопоиск моделей: ${e.message.split('\n')[0]}`);
      }
    }
    if (site.models) {
      try {
        const res = await collectModelPages(context, site, site.models);
        anyOpened = true;
        rows.push(...res.models);
        base.screens.push(...res.screens);
        notes.push(...res.notes);
        if (!res.hasSelectors) unfinished = true;
      } catch (e) {
        notes.push(`Обход моделей: ${e.message.split('\n')[0]}`);
      }
    }
    for (const [i, pageCfg] of (site.pages || []).entries()) {
      try {
        const res = await collectPage(context, site, pageCfg, i);
        anyOpened = true;
        rows.push(...res.models);
        if (res.screen) base.screens.push(res.screen);
        if (!res.hasSelectors) unfinished = true;
        else if (!res.models.length) notes.push(`На странице ${pageCfg.url} не нашлось ни одной модели`);
      } catch (e) {
        notes.push(`Не открылась ${pageCfg.url}: ${e.message.split('\n')[0]}`);
      }
    }
    // Шаблон движка ничего не нашёл (сайт поменял вёрстку): пробуем автопоиск карточек на главной.
    if (!site.auto && !rows.some((r) => r.model)) {
      try {
        const res = await collectPage(context, site, { url: siteUrl(site), min_price: 600000, auto: true }, 'auto');
        anyOpened = true;
        if (res.models.length) {
          autoUsed = true;
          rows.push(...res.models);
          log(`  [${site.id}] шаблон не сработал, автопоиск нашёл карточки моделей: ${res.models.length}`);
          for (let i = notes.length - 1; i >= 0; i -= 1) if (/не нашлось ни одной модели|не нашлось ссылок на модели/.test(notes[i])) notes.splice(i, 1);
        }
      } catch (e) {
        notes.push(`Автопоиск моделей: ${e.message.split('\n')[0]}`);
      }
    }
    let byAi = false;
    // У части сайтов движка нет страниц моделей, но на главной цены «от» есть: это нормальный результат, а не замечание.
    if (site.template && site.template !== '*' && rows.some((r) => r.model && r.price !== '-')) {
      for (let i = notes.length - 1; i >= 0; i -= 1) if (/не нашлось ссылок на модели/.test(notes[i])) notes.splice(i, 1);
    }
    // Если подключён ИИ, сначала просим его выписать модели и цены с главной: это точнее общей цены по сайту.
    if (site.aggregate && !rows.some((r) => r.model) && aiConfigured()) {
      try {
        const page = await openPage(context, site, siteUrl(site), {});
        try {
          const text = await page.evaluate(() => document.body?.innerText || '');
          const found = await askAi({ brand: site.brand, site: site.site, pageText: trimPageText(text) });
          rows.push(...found.map((m) => ({ ...m, source_url: siteUrl(site) })));
          anyOpened = true;
          byAi = found.length > 0;
        } finally {
          await page.close();
        }
      } catch (e) {
        notes.push(`ИИ не помог: ${e.message.split('\n')[0]}`);
      }
    }
    if (!site.expired && (!anyOpened || (site.profile?.card && !rows.some(r => Number.isFinite(r.price))))) {
      // Доступ к статической версии иногда сохраняется при сбое браузерной загрузки.
      try {
        const response = await fetch(siteUrl(site), { redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error('Нет HTML страницы');
        const html = await response.text();
        const page = await context.newPage();
        try {
          const {text, cards, scoped} = await page.evaluate(({markup, cfg}) => {
            const doc = new DOMParser().parseFromString(markup, 'text/html');
            doc.querySelectorAll('script,style,noscript,svg,template').forEach(el => el.remove());
            const cards = [...doc.querySelectorAll('.t-rec')].map(card => [...card.querySelectorAll('.tn-atom')].map(el => el.textContent));
            const scoped = cfg ? [...doc.querySelectorAll(cfg.card)].map(card => {
              const label = card.querySelector(cfg.model);
              const raw = cfg.model_attr ? label?.getAttribute(cfg.model_attr) || '' : label?.textContent || '';
              const model = Object.entries(cfg.model_map || {}).find(([key]) => raw.includes(key))?.[1] || (cfg.model_attr ? '' : raw);
              return {model, price: cfg.price ? card.querySelector(cfg.price)?.textContent || '' : '',
                benefit: cfg.benefit ? [...card.querySelectorAll(cfg.benefit)].map(el => el.textContent).join(' | ') : ''};
            }) : [];
            const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
            const lines = [];
            while (walker.nextNode()) lines.push(walker.currentNode.textContent.trim());
            return {text: lines.filter(Boolean).join('\n'), cards, scoped};
          }, {markup: html, cfg: site.profile?.card});
          if (!BLOCKED.test(text.slice(0, 2000))) {
            for (const item of scoped) {
              const model = cleanModel(item.model, site.brand);
              const prices = isVehiclePrice(item.price) ? parsePrices(item.price).filter(n => n >= MIN_PRICE && n <= MAX_PRICE) : [];
              const benefit = benefitTotal(item.benefit);
              if (model && (prices.length || benefit)) rows.push({model, price: prices.length ? Math.min(...prices) : '-', max_benefit: benefit || '-', source_url: siteUrl(site)});
            }
            const offers = [...rows, ...labelledOffers(text, site, site.profile?.modelNames), ...atomOffers(cards, site)];
            if (offers.some(row => Number.isFinite(row.price) || Number.isFinite(row.max_benefit))) {
              site.sourceText = text;
              site.offerCards = cards;
              anyOpened = true;
              notes.push('Предложения подтверждены в HTML главной. Проверка в браузере не завершена');
            }
          }
        } finally { await page.close(); }
      } catch { /* Сохраняем причины основной ошибки доступа. */ }
    }
    if (!anyOpened) return { ...base, status: 'access_error', comment: notes.join('; ') };

    const validRows = rows.filter(r => r.model).map(r => {
      if (r.price === '-' || (r.price >= MIN_PRICE && r.price <= MAX_PRICE)) return r;
      notes.push(`${r.model}: отброшена неподтверждённая цена ${r.price} ₽`);
      return { ...r, price: '-' };
    });
    // Выгоды, которых не нашлось в карточках, ищем в баннерах и сносках главной страницы
    // («Выгода в размере 150 000 рублей указана для автомобилей «Geely Coolray»»).
    let homeText = null;
    const readHome = async () => {
      if (homeText !== null) return homeText;
      if (site.visibleText) return homeText = site.visibleText;
      const page = await openPage(context, site, siteUrl(site), {});
      try {
        homeText = await page.evaluate(() => document.body?.innerText || '');
      } finally {
        await page.close();
      }
      return homeText;
    };
    let labelled = [];
    try {
      const visible = await readHome().catch(() => '');
      const sources = [...new Set([visible, site.sourceText].filter(Boolean))];
      labelled = mergeModels(sources.flatMap(text => labelledOffers(text, site, site.profile?.modelNames)));
      if (site.offerCards?.length) {
        const scoped = atomOffers(site.offerCards, site);
        const scopedKeys = new Set(scoped.map(row => modelKey(row.model)));
        labelled = [...labelled.filter(row => !scopedKeys.has(modelKey(row.model))), ...scoped];
      }
    } catch (e) {
      notes.push(`Главная страница недоступна для сверки: ${e.message.split('\n')[0]}`);
    }
    const models = reconcileOffers(validRows, labelled, site);
    if (homeText && models.length) {
      const found = benefitsByModel(homeText, models.map(m => m.model));
      for (const m of models) {
        const value = found.get(m.model);
        if (value && (!m.max_benefit || m.max_benefit === '-')) m.max_benefit = value;
      }
    }
    if (models.length) {
      for (let i = notes.length - 1; i >= 0; i--) {
        if (/не нашлось ни одной модели|не нашлось ссылок на модели/.test(notes[i])) notes.splice(i, 1);
      }
    }
    const problems = validateModels(models);
    const noPrice = models.filter((m) => m.price === '-').map((m) => m.model);
    if (noPrice.length && !unfinished) problems.push(`Не нашлась цена: ${noPrice.join(', ')}`);
    if (unfinished) problems.unshift('Сценарий не заполнен до конца, сделан снимок страницы');
    if (!models.length && !unfinished) problems.push('Модели не найдены');
    const all = [...problems, ...notes];
    if (site.template === '*') {
      base.template = '*';
      all.push(`Собрано запасным шаблоном (движок: ${site.engine || 'не определён'}), цифры надо проверить`);
    } else if (site.template) {
      base.template = site.template;
      all.push(`Собрано по общему шаблону движка ${site.template}`);
    }
    if (byAi) all.push('Модели и цены разобрал ИИ по тексту главной страницы, цифры проверьте');
    if (autoUsed) all.push('Модели найдены автопоиском карточек на главной, цифры проверьте');
    const ok = site.template !== '*' && !byAi && !autoUsed && all.length === (site.template ? 1 : 0);
    const result = { ...base, models, status: ok ? 'ok' : 'needs_check', comment: all.join('; ') };
    return result;
  } finally {
    await context.close();
  }
}

async function main() {
  const onlyId = process.argv.includes('--site') ? process.argv[process.argv.indexOf('--site') + 1] : null;
  const allSites = await loadSites(onlyId);
  // Сайты с «Проверять УТП: Нет» в лист УТП не попадают и не сверяются.
  const noUtp = new Set(allSites.filter((s) => s.utp === false).map((s) => String(s.id)));
  if (noUtp.size) log(`УТП отключено для сайтов: ${noUtp.size}`);
  const { run: scenarios, skipped } = splitUnverified(allSites.filter((s) => !noUtp.has(String(s.id))));
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const previous = loadPrevious(today);
  const prevById = new Map((previous?.sites || []).map((s) => [String(s.id), s]));
  log(`Сайтов к проверке: ${scenarios.length}. Прошлый сбор: ${previous?.date || 'нет'}`);

  // CHROMIUM_PATH: путь к своему браузеру, если Playwright не скачал свой.
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const results = skipped.map(({ site, health }) => ({
    id: site.id, company: site.company || '', responsible: site.responsible || '', site: site.site, brand: site.brand || '',
    models: [], status: 'access_error', comment: SKIP_REASON(health), change: CHANGE.error, changes: [], seconds: 0, pages_opened: 0,
  }));
  const queue = [...scenarios];

  // Сохраняет итог. stopped = сбор остановили кнопкой в приложении: пишем то, что успели,
  // а непроверенные сайты оставляем как в прошлом сборе, чтобы ничего не потерять.
  let saved = false;
  function saveReport(stopped) {
    if (saved) return;
    saved = true;
    const done = new Set(results.map((r) => String(r.id)));
    let sites = results;
    if (onlyId || stopped) {
      const latest = readJson(path.join(UTP, 'latest.json'));
      // У непроверенных сайтов оставляем только снимки, которые ещё лежат на месте.
      const kept = (latest?.sites || []).filter((s) => !done.has(String(s.id)) && !noUtp.has(String(s.id)))
        .map((s) => ({ ...s, screens: (s.screens || []).filter((f) => fs.existsSync(path.join(ROOT, f))) }));
      sites = [...kept, ...results];
    }
    assertUniqueIds(sites);
    sites = sortSites(sites);
    // Снимки сайтов, которых больше нет в списке, не нужны.
    const keep = new Set(sites.map((s) => String(s.id)));
    if (fs.existsSync(SCREENS)) {
      for (const d of fs.readdirSync(SCREENS)) if (!keep.has(d)) fs.rmSync(path.join(SCREENS, d), { recursive: true, force: true });
    }
    const report = {
      date: today,
      checked_at: now.toISOString(),
      previous_date: previous?.date || null,
      previous_checked_at: previous?.checked_at || null,
      ...(onlyId ? { partial: true } : {}),
      total_seconds: Math.round((Date.now() - now.getTime()) / 1000),
      parallel: PARALLEL,
      ...(stopped ? { stopped: true, checked: results.length, planned: scenarios.length } : {}),
      summary: summarize(sites),
      sites,
    };

    fs.mkdirSync(HISTORY, { recursive: true });
    fs.writeFileSync(path.join(UTP, 'latest.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(HISTORY, `${today}.json`), JSON.stringify(report, null, 2));

    const dates = fs.readdirSync(HISTORY).map((f) => f.replace('.json', ''));
    for (const d of historyToDelete(dates, today)) {
      fs.rmSync(path.join(HISTORY, `${d}.json`));
      log(`Удалён старый сбор ${d}`);
    }
    log(stopped ? `Сбор остановлен: проверено ${results.length} из ${scenarios.length}, сохранено` : `Готово за ${report.total_seconds} с:`, JSON.stringify(report.summary));
  }
  // GitHub при отмене сначала посылает сигнал и даёт несколько секунд: успеваем сохранить.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      saveReport(true);
      process.exit(0);
    });
  }
  async function worker() {
    while (queue.length) {
      const site = queue.shift();
      log(`→ [${site.id}] ${site.site}`);
      const started = Date.now();
      // Старые снимки сайта удаляем только перед его проверкой: у остальных они остаются.
      fs.rmSync(path.join(SCREENS, String(site.id)), { recursive: true, force: true });
      let timer;
      const limit = Number(process.env.SITE_TIMEOUT_MS) || 600000;
      const timeout = new Promise(resolve => {
        timer = setTimeout(() => {
          site.expired = true;
          site.activeContext?.close().catch(() => {});
          const labelled = labelledOffers(site.sourceText || site.visibleText, site, site.profile?.modelNames);
          const cards = atomOffers(site.offerCards || [], site);
          const covered = new Set(cards.map(row => modelKey(row.model)));
          const confirmed = [...cards, ...labelled.filter(row => !covered.has(modelKey(row.model)))]
            .filter(row => Number.isFinite(row.price) || Number.isFinite(row.max_benefit))
            .map(row => ({...row, source_url: siteUrl(site)}));
          resolve({ id: site.id, site: site.site, brand: site.brand, company: site.company,
            responsible: site.responsible, models: confirmed, screens: [], status: 'needs_check',
            comment: 'Истекло время проверки сайта. УТП требует повторного сбора' });
        }, limit);
      });
      const res = await Promise.race([collectSite(browser, site), timeout]).finally(() => clearTimeout(timer));
      // Сколько времени и страниц ушло на сайт: по этому считаем, сколько сайтов успеем за один сбор.
      res.seconds = Math.round((Date.now() - started) / 1000);
      res.pages_opened = site.pagesOpened || 0;
      Object.assign(res, decideChange(res, previousOf(prevById, site)));
      log(`  [${site.id}] ${res.change}. Моделей: ${res.models.length}. ${res.seconds} с, страниц: ${res.pages_opened}${res.comment ? `. ${res.comment}` : ''}`);
      results.push(res);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  saveReport(false);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
