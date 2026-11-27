// Отдельная регрессия браузерного шаблона: node collector/amk-profile.browser.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
const profiles = JSON.parse(fs.readFileSync(new URL('../templates/sites.json', import.meta.url)));
const config = profiles['amk-chery.ru'].card;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage();
  await page.setContent(['T4', 'T4L'].map((model, i) =>
    `<article class="amk-card"><span class="amk-ad-benefit">Выгода до ${[260000, 340000][i]} ₽</span>
     <div class="amk-card-body"><h3 class="amk-model-name">TENET ${model}</h3>
     <div class="amk-price">от ${[1950000, 2050000][i]} ₽</div><p>Кредит от 8900 ₽/мес.</p></div></article>`
  ).join(''));
  const result = await page.locator(config.card).evaluateAll((cards, selectors) =>
    cards.map(card => [selectors.model, selectors.price, selectors.benefit].map(s => card.querySelector(s)?.textContent)), config);
  assert.deepEqual(result, [
    ['TENET T4', 'от 1950000 ₽', 'Выгода до 260000 ₽'],
    ['TENET T4L', 'от 2050000 ₽', 'Выгода до 340000 ₽'],
  ]);
} finally {
  await browser.close();
}
