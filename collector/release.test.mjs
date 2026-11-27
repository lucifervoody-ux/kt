import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { previousOf, splitUnverified, store } from './common.mjs';
import { parseSites, validateExport } from './sheet.mjs';
import { verifyExport } from './export.mjs';
import { isModelPageLink, verifiedCardResults } from './site-profile.mjs';
import { reportAvailability } from '../src/lib/status.js';
import { cleanModel } from './lib.mjs';

function reports() {
  const site = { id: 1, site: 'dealer.ru/Catalog' };
  const result = fields => ({ checked_at: '2026-11-25T12:00:00Z', sites: [{ ...site, ...fields }] });
  return {
    registry: [{ ...site, active: true, utp: true }],
    health: result({ health: 'Работает' }), konget: result({ konget: 'Скрипт есть' }),
    utp: result({ change: 'Не изменилось' }),
  };
}

test('выгрузка проверяет полноту всех трёх отчётов до записи', () => {
  validateExport(reports());
  for (const field of ['health', 'konget', 'utp']) {
    for (const invalid of [null, {}, { ...reports()[field], sites: [] }, { ...reports()[field], stopped: true }]) {
      assert.throws(() => validateExport({ ...reports(), [field]: invalid }));
    }
  }
  const r = reports();
  r.health.checked_at = '2026-11-26T12:00:00Z';
  assert.throws(() => validateExport(r), /разных прогонах/);
});

test('страницы одного домена с разными путями и параметрами считаются отдельно', () => {
  const r = reports();
  const prev = new Map([['1', r.utp.sites[0]]]);
  for (const address of ['dealer.ru/catalog', 'dealer.ru/Catalog?a=1']) {
    r.registry[0].site = address;
    assert.throws(() => validateExport(r), /ID: 1/);
    assert.equal(previousOf(prev, r.registry[0]), undefined);
  }
  r.registry[0].site = 'https://www.DEALER.ru/Catalog/';
  validateExport(r);
});

test('выключенный сбор УТП допускает пустой отчёт, пустой реестр останавливает выгрузку', () => {
  const r = reports();
  r.registry[0].utp = false;
  r.utp.sites = [];
  validateExport(r);
  r.registry = [];
  assert.throws(() => validateExport(r), /нет активных/);
});

test('в рабочем реестре неверный ID или пустой адрес не пропускаются молча', () => {
  for (const row of [['abc', 'x.ru'], ['1.5', 'x.ru'], ['1', '']]) {
    assert.throws(() => parseSites([['ID', 'Сайт'], [], row], { strict: true }), /строке 3/);
  }
  assert.throws(() => parseSites([['ID', 'Бренд']], { strict: true }), /заголовки/);
});

test('точечный и остановленный сборы сохраняют полную базу для сравнения', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'konget-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = store('utp', dir);
  const full = { date: '2026-11-25', sites: [{ id: 1 }] };
  db.save(full);
  db.save({ ...full, sites: [{ id: 2 }], partial: true });
  db.save({ ...full, date: '2026-11-26', stopped: true });
  // Раньше такие файлы могли попасть в историю.
  fs.writeFileSync(path.join(db.dir, 'history', '2026-11-26.json'), JSON.stringify(db.latest()));
  assert.deepEqual(db.previous('2026-11-25', true), full);
  assert.deepEqual(db.previous('2026-11-27'), full);
  assert.equal(db.latest().stopped, true);
});

test('прежняя недоступность из устаревшего или частичного отчёта не пропускает сайт', () => {
  const sites = [{ id: 1, site: 'dealer.ru' }];
  const bad = { sites: [{ ...sites[0], health: 'Не работает' }] };
  for (const meta of [{ checked_at: '2020-11-25T00:00:00Z' }, { partial: true }]) {
    assert.deepEqual(splitUnverified(sites, { ...bad, ...meta }), { run: sites, skipped: [] });
  }
});

test('чтение после выгрузки проверяет числа, пустые значения и удаление старого хвоста', () => {
  const checks = [{ title: 'УТП', first: 3, last: 5, columns: [{ index: 1, values: [1, 2] }, { index: 2, values: ['Да', ''] }] }];
  const rows = [[null, 1, 'Да'], [null, 2]];
  verifyExport(checks, [{ values: rows }]);
  assert.throws(() => verifyExport(checks, []));
  assert.throws(() => verifyExport(checks, [{ values: [...rows, [null, 3]] }]), /B5/);
  assert.throws(() => verifyExport(checks, [{ values: [[null, '1', 'Да'], rows[1]] }]), /B3/);
});

test('доменный шаблон требует совпадения каждой модели, цены и указанной выгоды', () => {
  const card = { model: 'X50+', price: 2219990, max_benefit: 100000 };
  const profile = { verifyCards: true, modelNames: ['Belgee X50+'], card: { benefit: '.benefit' } };
  const verified = (cards, models) => verifiedCardResults(cards, models, profile, 'Belgee');
  assert.equal(verified([card], [card]), true);
  for (const change of [{ price: 2220000 }, { max_benefit: '-' }, { model: 'X50' }]) {
    assert.equal(verified([card], [{ ...card, ...change }]), false);
  }
  assert.equal(verified([card], []), false);
  const partial = { ...card, max_benefit: '-' };
  assert.equal(verified([partial], [partial]), false);
  assert.equal(cleanModel('Обзор', 'Geely'), '');
});

test('Pages различает недоступный отчёт, отсутствие файла и загруженный результат', () => {
  assert.equal(reportAvailability('utp', undefined), 'Результат проверки пока недоступен');
  assert.equal(reportAvailability('utp', null), 'Отчёт проверки не найден');
  assert.equal(reportAvailability('health', { sites: [] }), '');
  assert.equal(reportAvailability('export'), 'История выгрузки недоступна');
  assert.equal(reportAvailability('export', null, { status: 'completed' }), '');
});

test('обход моделей исключает фотогалерею до применения лимита ссылок', () => {
  const home = 'https://dealer.example/';
  for (const path of ['assets/img/models/geely-ex5-em-i/banner.webp', 'models/x/full/1.JPG?v=5', 'models/x/price.pdf']) {
    assert.equal(isModelPageLink(new URL(path, home).href, home), false);
  }
  assert.equal(isModelPageLink(home + 'models/geely-ex5?mobile', home), true);
  assert.equal(isModelPageLink(home + 'models/catalog.html', home), true);
  assert.equal(isModelPageLink('https://other.example/models/x', home), false);
});
