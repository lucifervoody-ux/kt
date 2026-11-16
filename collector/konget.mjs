// Кнопка 2 «Наличие скрипта Конгет». Запускается только кнопкой.
// Открывает сайт как обычный посетитель, ждёт, пока появятся отложенные скрипты, и ищет
// //app.konget.ru/inject?token=… в коде страницы и среди загруженных файлов.
// Если скрипта не видно, а на сайте есть контейнер тегов, пишет «Проверить вручную».
// Если в сценарии сайта указан konget_token, сверяет, что на сайте стоит именно он.
// Итог: data/konget/latest.json и data/konget/history/<дата>.json.
//
// У себя: npm run konget   (один сайт: npm run konget -- --site 1)

import { chromium } from 'playwright';
import { KONGET, KONGET_ORDER, changedSince, countBy, kongetVerdict, sortBy } from './checks.mjs';
import {
  SKIP_REASON, argValue, keepUnchecked, loadSites, splitUnverified, log, previousOf, runQueue, siteBase, siteUrl, store,
} from './common.mjs';

const PARALLEL = Number(process.env.PARALLEL) || 10;
const TIMEOUT = 30_000;
const RETRY_TIMEOUT = 60_000;
// Отложенный скрипт добавляется через N секунд после загрузки (обычно около 9 с),
// а из контейнера тегов — когда тот сработает. Ждём с запасом.
const SETTLE_MS = Number(process.env.SETTLE_MS) || 12_000;

async function checkOnce(browser, site, timeout) {
  const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const requests = [];
  page.on('request', (req) => requests.push(req.url()));
  // Картинки, видео и шрифты для поиска скрипта не нужны: без них страницы грузятся заметно быстрее.
  await page.route('**/*', (route) => (['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue()));
  try {
    const res = await page.goto(siteUrl(site), { waitUntil: 'domcontentloaded', timeout });
    // Код страницы, как его отдал сервер: по нему видно, обычный скрипт или отложенный.
    const html = await res?.text().catch(() => '') || '';
    await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
    // Ждём отложенный скрипт, но как только Конгет заметен (в запросах или в коде страницы), дальше не ждём.
    const until = Date.now() + SETTLE_MS;
    while (Date.now() < until) {
      if (requests.some((u) => /konget/i.test(u)) || /konget/i.test(await page.content().catch(() => ''))) break;
      await page.waitForTimeout(500);
    }
    // Плюс код страницы после загрузки: туда попадают скрипты, добавленные позже.
    const dom = await page.content().catch(() => '');
    return { html, dom, requests, status: res?.status() || 0 };
  } catch (e) {
    return { error: e.message.split('\n')[0] };
  } finally {
    await context.close();
  }
}

// Сайт не открылся за 30 с — пробуем ещё раз за 60 с: с зарубежных серверов часть сайтов отвечает медленно.
async function checkSite(browser, site) {
  const first = await checkOnce(browser, site, TIMEOUT);
  if (first.error && /Timeout/i.test(first.error)) return checkOnce(browser, site, RETRY_TIMEOUT);
  return first;
}

async function main() {
  const onlyId = argValue('--site');
  const { run: sites, skipped } = splitUnverified(await loadSites(onlyId));
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const db = store('konget');
  const prevById = new Map((db.previous(today)?.sites || []).map((s) => [String(s.id), s]));
  log(`Сайтов к проверке: ${sites.length}`);

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const results = skipped.map(({ site, health }) => ({
    ...siteBase(site), konget: KONGET.down, tokens: [], reason: SKIP_REASON(health), expected: '', seconds: 0, was: '',
  }));
  let saved = false;
  const save = (stopped) => {
    if (saved) return;
    saved = true;
    const all = sortBy(KONGET_ORDER, 'konget')(onlyId || stopped ? keepUnchecked(db.latest(), results) : results);
    db.save({
      date: today,
      checked_at: now.toISOString(),
      total_seconds: Math.round((Date.now() - now.getTime()) / 1000),
      parallel: PARALLEL,
      ...(stopped ? { stopped: true, checked: results.length, planned: sites.length } : {}),
      summary: countBy(all, 'konget', KONGET_ORDER),
      sites: all,
    });
    log(stopped ? `Остановлено: проверено ${results.length} из ${sites.length}` : 'Готово', JSON.stringify(countBy(all, 'konget', KONGET_ORDER)));
  };

  await runQueue(sites, PARALLEL, async (site) => {
    const started = Date.now();
    const raw = await checkSite(browser, site);
    const res = {
      ...siteBase(site),
      ...kongetVerdict({ ...raw, expected: site.konget_token || '' }),
      expected: site.konget_token ? String(site.konget_token) : '',
      seconds: Math.round((Date.now() - started) / 1000),
    };
    res.was = changedSince(previousOf(prevById, site), res, 'konget');
    log(`[${site.id}] ${site.site}: ${res.konget}${res.kind ? ` (${res.kind})` : ''}${res.tokens.length ? ` ${res.tokens.join(', ')}` : ''}${res.reason ? ` (${res.reason})` : ''}`);
    results.push(res);
  }, () => save(true));
  await browser.close();
  save(false);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
