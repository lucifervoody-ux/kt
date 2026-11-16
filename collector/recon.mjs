// «Разведка сайтов»: обходит сайты и записывает, как они устроены — движок, где модели, в каких блоках цены и выгоды,
// как стоит скрипт Конгет. По этим данным пишутся шаблоны движков. Ничего не меняет ни в таблице, ни на сайтах.
// Результат: data/recon/<id>.json по каждому сайту и data/recon/summary.json со сводкой по движкам.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { DATA, argValue, loadSites, log, runQueue, siteUrl } from './common.mjs';
import { detectEngine } from './checks.mjs';

const PARALLEL = Number(process.env.PARALLEL) || 6;
const OUT = path.join(DATA, 'recon');

// Что исполняется в браузере: собирает описание страницы. Здесь только чтение.
function inspect() {
  const rub = /\d[\d\s ]{4,}\s*(?:₽|руб)/i;
  const benefit = /выгод|скидк|преимуществ/i;
  const sel = (el) => {
    const parts = [];
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 3; n = n.parentElement, i += 1) {
      const cls = [...n.classList].filter((c) => !/^\d|^(is|has)-/.test(c)).slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('');
      parts.unshift(`${n.tagName.toLowerCase()}${cls}`);
    }
    return parts.join(' > ');
  };
  const count = (re) => {
    const map = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const t = node.textContent.replace(/\s+/g, ' ').trim();
      if (t.length < 4 || t.length > 200 || !re.test(t) || !node.parentElement) continue;
      const key = sel(node.parentElement);
      const item = map.get(key) || { selector: key, count: 0, sample: t.slice(0, 80) };
      item.count += 1;
      map.set(key, item);
    }
    return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 8);
  };
  const links = [...document.querySelectorAll('a[href]')].map((a) => {
    try { const u = new URL(a.href, location.href); return u.origin === location.origin ? u.pathname : ''; } catch { return ''; }
  }).filter((p) => p && p !== '/');
  const groups = new Map();
  for (const p of links) {
    const seg = p.split('/').filter(Boolean);
    const key = seg.length > 1 ? `/${seg[0]}/*` : `/${seg[0] || ''}`;
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  return {
    title: document.title,
    text_length: (document.body?.innerText || '').length,
    price_blocks: count(rub),
    benefit_blocks: count(benefit),
    link_groups: [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
    model_cards: [...document.querySelectorAll('[class*="model"], [class*="card"], [class*="car-"]')].slice(0, 400)
      .filter((el) => rub.test(el.innerText || '') && (el.innerText || '').length < 300)
      .map(sel).slice(0, 6),
  };
}

async function look(browser, site) {
  const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  try {
    const res = await page.goto(siteUrl(site), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const html = await page.content();
    const info = await page.evaluate(inspect);
    // Страница модели: первая ссылка из самой частой группы ссылок вида /что-то/*.
    const model = info.link_groups.find(([k]) => k.endsWith('/*') && !/legal|policy|news|blog|service|about|img|files|upload/i.test(k));
    let modelInfo = null;
    if (model) {
      const href = await page.evaluate((prefix) => {
        const a = [...document.querySelectorAll('a[href]')].find((x) => new URL(x.href, location.href).pathname.startsWith(prefix));
        return a ? a.href : '';
      }, model[0].replace('*', ''));
      if (href) {
        await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(3000);
        modelInfo = { url: href, ...(await page.evaluate(inspect).catch(() => ({}))) };
      }
    }
    return {
      status: res?.status() || 0,
      engine: detectEngine(html, page.url()),
      final_url: page.url(),
      konget: [...new Set(requests.filter((u) => /konget/i.test(u)))].slice(0, 3),
      home: info,
      model_page: modelInfo,
    };
  } catch (e) {
    return { error: e.message.split('\n')[0] };
  } finally {
    await context.close();
  }
}

async function main() {
  const onlyId = argValue('--site');
  // --hosts a.ru,b.ru: обойти указанные адреса без чтения таблицы (для запуска на своём компьютере).
  const hosts = argValue('--hosts');
  const sites = hosts
    ? hosts.split(',').map((h, i) => ({ id: `h${i + 1}`, site: h.trim(), brand: '' }))
    : await loadSites(onlyId);
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const rows = [];
  const save = () => {
    const byEngine = {};
    for (const r of rows) (byEngine[r.engine || 'нет данных'] ||= []).push(r.id);
    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ checked: rows.length, by_engine: byEngine }, null, 1));
  };
  await runQueue(sites, PARALLEL, async (site) => {
    const r = await look(browser, site);
    rows.push({ id: site.id, engine: r.engine || '' });
    fs.writeFileSync(path.join(OUT, `${site.id}.json`), JSON.stringify({ id: site.id, site: site.site, brand: site.brand, ...r }, null, 1));
    log(`[${site.id}] ${site.site}: ${r.engine || r.error}`);
  }, save);
  await browser.close();
  save();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
