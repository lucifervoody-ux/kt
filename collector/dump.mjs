// Снимок страниц для разбора вёрстки: открывает адреса как обычный браузер и сохраняет
// код страницы (.html) и видимый текст (.txt) в папку debug/. Нужен, чтобы писать шаблоны:
// из облака Claude сайты дилеров не открываются, а из GitHub — открываются.
// Запуск: node collector/dump.mjs "site.ru https://site.ru/models/x"
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, log, runQueue } from './common.mjs';

const OUT = path.join(ROOT, 'debug');
const urls = String(process.argv[2] || process.env.URLS || '').split(/[\s,]+/).filter(Boolean)
  .map((u) => (/^https?:\/\//.test(u) ? u : `https://${u}/`));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  await runQueue(urls, 4, async (url) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    const u = new URL(url);
    const name = `${u.hostname}${u.pathname}`.replace(/\/+$/, '').replace(/[^a-z0-9а-яё.-]+/gi, '_');
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 150)); }
      });
      await page.waitForTimeout(1500);
      fs.writeFileSync(path.join(OUT, `${name}.html`), await page.content());
      fs.writeFileSync(path.join(OUT, `${name}.txt`), `${page.url()}\n\n${await page.evaluate(() => document.body.innerText)}`);
      log(`сохранил ${url}`);
    } catch (e) {
      fs.writeFileSync(path.join(OUT, `${name}.txt`), `ОШИБКА ${e.message.split('\n')[0]}`);
      log(`не открылась ${url}: ${e.message.split('\n')[0]}`);
    } finally {
      await context.close();
    }
  });
  await browser.close();
}

main();
