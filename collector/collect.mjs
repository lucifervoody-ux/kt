// Кнопка 3 «Сверить УТП». Запускается на GitHub (Actions) по кнопке в приложении
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
import { detectEngine } from './checks.mjs';
import { aiConfigured, askAi, trimPageText } from './ai.mjs';
import { load as loadYaml } from 'js-yaml';
import {
  CHANGE, extractPromoLines, parsePrices, parseBenefits, parseAmounts, cleanModel, mergeModels, validateModels, decideChange, sortSites, summarize, historyToDelete,
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

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Прошлый сбор: самый свежий файл истории с датой раньше сегодняшней.
function loadPrevious(today) {
  if (!fs.existsSync(HISTORY)) return null;
  const dates = fs.readdirSync(HISTORY).map((f) => f.replace('.json', '')).filter((d) => d < today).sort();
  return dates.length ? readJson(path.join(HISTORY, `${dates.at(-1)}.json`)) : null;
}

// Открывает страницу и выполняет шаги сценария: нажать кнопки, подождать, прокрутить.
async function openPage(context, site, url, cfg = {}) {
  site.pagesOpened = (site.pagesOpened || 0) + 1;
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
  } catch (e) {
    await page.close();
    throw e;
  }
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  for (const sel of cfg.click || []) {
    await page.click(sel, { timeout: 5_000 }).catch(() => log(`  [${site.id}] не нашёл кнопку ${sel}`));
  }
  if (cfg.wait_for) await page.waitForSelector(cfg.wait_for, { timeout: 15_000 }).catch(() => {});
  if (cfg.scroll) await autoScroll(page);
  return page;
}

// Снимок и код страницы: по ним видно, где на сайте цены, и можно дописать сценарий.
async function snapshot(page, site, name) {
  fs.mkdirSync(path.join(SCREENS, String(site.id)), { recursive: true });
  const screen = `data/screens/${site.id}/${name}.jpg`;
  await page.screenshot({ path: path.join(ROOT, screen), fullPage: true, type: 'jpeg', quality: 50 });
  fs.writeFileSync(path.join(SCREENS, String(site.id), `${name}.html`), await page.content());
  return screen;
}

// Одна страница сайта: открыть, выполнить шаги сценария, собрать карточки моделей.
async function collectPage(context, site, pageCfg, index) {
  const page = await openPage(context, site, pageCfg.url, pageCfg);
  try {

    const hasSelectors = pageCfg.card && (pageCfg.model || pageCfg.model_name);
    let rows = [];
    if (hasSelectors) {
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
    const screen = !hasSelectors || rows.length === 0 ? await snapshot(page, site, index) : null;

    // model_map: когда на сайте вместо названия картинка, сопоставляем по коду модели из ссылки.
    const mapName = (raw) => {
      const hit = Object.entries(pageCfg.model_map || {}).find(([key]) => raw.includes(key));
      return hit ? hit[1] : raw;
    };
    const models = rows.map((r) => {
      r.model = pageCfg.model_name || mapName(r.model);
      // У лендингов в цену не берём суммы из фраз про выгоду, скидку, платёж и кредит: «с выгодой от 1 001 000 руб.» — не цена.
      const priceText = pageCfg.model_name ? String(r.price).replace(/(выгод|скидк|экономи|кредит|рассрочк|платеж|платёж|первоначальн)[^.\n|]{0,70}/gi, ' ') : r.price;
      const prices = parsePrices(priceText).filter((n) => n >= (pageCfg.min_price || 0));
      const benefits = (pageCfg.benefit_all ? parseAmounts : parseBenefits)(r.benefit);
      return {
        model: cleanModel(r.model.split('\n').map((l) => l.trim()).find(Boolean), site.brand),
        price: prices.length ? Math.min(...prices) : '-',
        max_benefit: benefits.length ? Math.max(...benefits) : '-',
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
    const prices = parsePrices(l.around || '').filter((n) => n >= minPrice);
    // Блок с несколькими разными ценами — не карточка одной модели: такую цену не берём.
    if (!prices.length || (!l.onlyPrice && new Set(prices).size > 1)) continue;
    const target = /[?#]/.test(l.href) ? menuPrice : plainPrice;
    const k = key(l.href);
    target.set(k, Math.min(...prices, target.get(k) ?? Infinity));
  }
  const listPrice = { get: (k) => plainPrice.get(k) ?? menuPrice.get(k) };
  links = links.filter((l) => !l.onlyPrice);
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
      const found = await p.evaluate(({ price, benefit, title, trim }) => {
        const texts = (root, sel) => (sel ? [...root.querySelectorAll(sel)].map((e) => e.innerText || e.textContent) : []);
        const roots = trim ? [...document.querySelectorAll(trim)] : [document];
        return {
          title: texts(document, title)[0] || '',
          prices: roots.flatMap((r) => texts(r, price)),
          // Выгоды часто стоят отдельно от комплектаций, поэтому ищем их по всей странице.
          benefits: texts(document, benefit),
        };
      }, page);
      // min_price: отсекаем платежи и скидки, которые сайт показывает рядом с ценой (1 754 ₽, 50 000 ₽).
      const prices = found.prices.flatMap(parsePrices).filter((n) => n >= (page.min_price || 0));
      const benefits = found.benefits.flatMap(page.benefit_all ? parseAmounts : parseBenefits);
      // Текст ссылки «О модели» — не название: тогда берём его из адреса страницы (/models/gs3 → GS3).
      const generic = /^(о модели|подробнее|узнать больше|смотреть)$/i;
      const fromUrl = () => decodeURIComponent(new URL(link.href).pathname.split('/').filter(Boolean).at(-1) || '').replace(/[-_]+/g, ' ').toUpperCase();
      const raw = (found.title || link.name).split('\n').map((l) => l.trim()).find(Boolean) || '';
      const name = cleanModel(generic.test(raw) ? fromUrl() : raw, site.brand);
      // Снимок: если сценарий не дописан, или на странице модели не нашлось цены (один на сайт).
      if (!hasSelectors || (!prices.length && listPrice.get(key(link.href)) == null && !screens.length)) screens.push(await snapshot(p, site, `model-${i}`));
      const fromList = listPrice.get(key(link.href));
      models.push({
        model: name,
        price: prices.length ? Math.min(...prices) : (fromList ?? '-'),
        max_benefit: benefits.length ? Math.max(...benefits) : '-',
        source_url: link.href,
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
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
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
  };
}

const AGG_NAME = 'Весь сайт';

async function collectSite(browser, site) {
  if (!site.pages?.length && !site.models) {
    const known = healthById.get(String(site.id));
    let engine = known && host(known.site) === host(site.site) ? known.engine : '';
    if (!engine || !templates.has(engine)) {
      // Движок неизвестен или для него ещё нет шаблона: открываем главную, определяем движок
      // и сохраняем снимок — по нему можно сделать шаблон.
      const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1366, height: 900 } });
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
  return collectSiteWith(browser, site);
}

async function collectSiteWith(browser, site) {
  const base = {
    id: site.id, company: site.company || '', responsible: site.responsible || '', site: site.site, brand: site.brand || '', file: site.file,
    models: [], screens: [], comment: '',
  };
  if (!site.pages?.length && !site.models) {
    const engine = site.engine ? ` (движок: ${site.engine})` : '';
    return { ...base, status: 'no_scenario', comment: `Для сайта ещё нет ни сценария, ни шаблона движка${engine}` };
  }
  const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1366, height: 900 } });
  try {
    const rows = [];
    const notes = [];
    let anyOpened = false;
    let unfinished = false;
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
    // Лендинг без списка моделей (Tilda и похожие): берём с главной самую низкую цену и самую большую выгоду по всему сайту.
    // Это не цены по моделям, но по ним видно, когда на сайте поменялось предложение.
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
    if (site.aggregate && !rows.some((r) => r.model)) {
      try {
        const agg = { url: siteUrl(site), card: 'body', model_name: AGG_NAME, price: 'body', benefit: 'body', min_price: 500000, ...site.aggregate };
        const res = await collectPage(context, site, agg, 'agg');
        anyOpened = true;
        rows.push(...res.models);
        if (res.screen) base.screens.push(res.screen);
      } catch (e) {
        notes.push(`Главная не открылась: ${e.message.split('\n')[0]}`);
      }
    }
    if (!anyOpened && site.template === '*') {
      // Запасной шаблон не нашёл на главной ссылок на модели: для этого движка нужен свой шаблон.
      return { ...base, status: 'no_scenario', comment: `Для движка «${site.engine || 'не определён'}» ещё нет шаблона, запасной не нашёл модели` };
    }
    if (!anyOpened) return { ...base, status: 'access_error', comment: notes.join('; ') };

    const models = mergeModels(rows.filter((r) => r.model));
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
    const aggregated = rows.some((r) => r.model === AGG_NAME);
    if (aggregated) all.push('Лендинг без списка моделей: цена и выгода взяты со всей главной страницы, проверьте их');
    const ok = site.template !== '*' && !aggregated && !byAi && all.length === (site.template ? 1 : 0);
    const result = { ...base, models, status: ok ? 'ok' : 'needs_check', comment: all.join('; ') };
    // Цены по моделям тут ненадёжны: сравниваем сайт по тексту акций с главной страницы.
    if (site.template === '*' || aggregated || byAi) {
      try {
        const page = await openPage(context, site, siteUrl(site), {});
        try {
          result.promo_lines = extractPromoLines(await page.evaluate(() => document.body?.innerText || ''));
        } finally {
          await page.close();
        }
        if (result.promo_lines.length) {
          result.text_mode = true;
          result.comment += `${result.comment ? '; ' : ''}Сравнение по тексту акций главной страницы`;
        }
      } catch (e) {
        result.comment += `${result.comment ? '; ' : ''}Текст главной не прочитан: ${e.message.split('\n')[0]}`;
      }
    }
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
      const res = await collectSite(browser, site);
      // Сколько времени и страниц ушло на сайт: по этому считаем, сколько сайтов успеем за один сбор.
      res.seconds = Math.round((Date.now() - started) / 1000);
      res.pages_opened = site.pagesOpened || 0;
      Object.assign(res, decideChange(res, previousOf(prevById, site)));
      log(`  [${site.id}] ${res.change}. Моделей: ${res.models.length}. ${res.seconds} с, страниц: ${res.pages_opened}${res.comment ? `. ${res.comment}` : ''}`);
      results.push(res);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  await browser.close();

  saveReport(false);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
