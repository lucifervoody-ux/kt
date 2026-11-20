import { chromium } from 'playwright';
import {
  HEALTH, HEALTH_ORDER, KONGET, KONGET_ORDER, kongetVerdict, SURE_DOWN, changedSince, countBy, detectEngine, healthVerdict, sortBy,
} from './checks.mjs';
import {
  argValue, keepUnchecked, loadSites, log, previousOf, runQueue, siteBase, siteUrl, store,
} from './common.mjs';

const PARALLEL = Number(process.env.PARALLEL) || 6;
const TIMEOUT = 30_000;
const RETRY_TIMEOUT = 60_000;

async function checkOnce(browser, site, timeout) {
  const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const requests = [];
  page.on('request', (req) => requests.push(req.url()));
  const started = Date.now();
  try {
    const res = await page.goto(siteUrl(site), { waitUntil: 'domcontentloaded', timeout });
    const seconds = (Date.now() - started) / 1000;
    await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
    // Страницы, которые рисуются скриптом, появляются не сразу: ждём текст до 8 с, прежде чем назвать страницу пустой.
    await page.waitForFunction(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim().length >= 80, null, { timeout: 8_000 }).catch(() => {});
    const html = await res?.text().catch(() => '') || '';
    let dom = await page.content().catch(() => '');
    const status = res?.status() || 0;
    // Контейнер тегов может добавить скрипт через несколько секунд после загрузки.
    const deadline = Date.now() + (Number(process.env.SETTLE_MS) || 12_000);
    while (status < 400 && Date.now() < deadline && !requests.some((u) => /app\.konget\.ru\/inject\?[^#]*token=/i.test(u)) && !/app\.konget\.ru\/inject\?token=/i.test(html + dom)) {
      await page.waitForTimeout(500);
      dom = await page.content().catch(() => '');
    }
    return {
      status: res?.status() || 0, seconds, text: await page.evaluate(() => document.body?.innerText || '').catch(() => ''), title: await page.title().catch(() => ''), final_url: page.url(), html, dom, requests,
    };
  } catch (e) {
    return { error: e.message.split('\n')[0], seconds: (Date.now() - started) / 1000 };
  } finally {
    await context.close();
  }
}

// Если сайт не ответил, но это может быть временным или закрытым доступом, пробуем ещё раз, подольше.
export async function checkSite(browser, site) {
  const first = await checkOnce(browser, site, TIMEOUT);
  if (!first.error || SURE_DOWN.test(first.error)) return first;
  return checkOnce(browser, site, RETRY_TIMEOUT);
}

async function main() {
  const onlyId = argValue('--site');
  const sites = await loadSites(onlyId);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const db = store('health');
  const scriptDb = store('konget');
  const prevScript = new Map((scriptDb.previous(today)?.sites || []).map((s) => [String(s.id), s]));
  const prevById = new Map((db.previous(today)?.sites || []).map((s) => [String(s.id), s]));
  log(`Сайтов к проверке: ${sites.length}`);

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const results = [];
  const scripts = [];
  let saved = false;
  const save = (stopped) => {
    if (saved) return;
    saved = true;
    const savePart = (target, rows, field, order) => {
      const all = sortBy(order, field)(onlyId || stopped ? keepUnchecked(target.latest(), rows) : rows);
      target.save({
        date: today,
        checked_at: now.toISOString(),
        total_seconds: Math.round((Date.now() - now.getTime()) / 1000),
        parallel: PARALLEL,
        ...(stopped ? { stopped: true, checked: rows.length, planned: sites.length } : {}),
        summary: countBy(all, field, order),
        sites: all,
      });
    };
    savePart(db, results, 'health', HEALTH_ORDER);
    savePart(scriptDb, scripts, 'konget', KONGET_ORDER);
    log(`Сохранено сайтов: ${results.length} из ${sites.length}`);
  };

  await runQueue(sites, PARALLEL, async (site) => {
    const started = Date.now();
    const raw = await checkSite(browser, site);
    const verdict = healthVerdict({ ...raw, site: site.site, finalUrl: raw.final_url });
    let script = kongetVerdict({ ...raw, expected: site.konget_token || '' });
    if ([HEALTH.down, HEALTH.stub].includes(verdict.health)) {
      script = { konget: KONGET.down, reason: verdict.reason };
    } else if (verdict.health === HEALTH.manual && !script.tokens?.length) {
      script = { konget: KONGET.manual, reason: verdict.reason };
    }
    const res = {
      ...siteBase(site),
      ...verdict,
      konget: script.konget,
      code: raw.status || null,
      load_seconds: Math.round(raw.seconds * 10) / 10,
      final_url: raw.final_url || '',
      engine: raw.error ? '' : detectEngine(raw.dom, raw.final_url || siteUrl(site)),
      title: (raw.title || '').slice(0, 120),
      seconds: Math.round((Date.now() - started) / 1000),
    };
    res.was = changedSince(previousOf(prevById, site), res, 'health');
    log(`[${site.id}] ${site.site}: ${res.health}${res.reason ? ` (${res.reason})` : ''}${res.engine ? `, движок ${res.engine}` : ''}`);
    scripts.push({
      ...siteBase(site), konget: script.konget, kind: script.kind || '',
      reason: script.konget === KONGET.wrong ? 'Токен отличается от ожидаемого' : script.reason,
      was: changedSince(previousOf(prevScript, site), script, 'konget'), seconds: res.seconds,
    });
    results.push(res);
  }, () => save(true));
  await browser.close();
  save(false);
}

if (process.argv[1] === import.meta.filename) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
