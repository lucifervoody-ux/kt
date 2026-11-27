// Кнопка 3 «Выгрузить данные в таблицу».
// Берёт последние результаты трёх проверок и пишет их в листы Google-таблицы:
// «Сводка», «Сайты и скрипт», «УТП».
//
// Таблицу оформляет человек: листы, заголовки, ширину колонок, выпадающие списки, цвета,
// условное форматирование. Программа ничего из этого не меняет. Она находит свои колонки
// по заголовкам (шапка в первых строках листа), стирает в них старые значения ниже шапки, но не выше строки 3 и пишет новые,
// выбирая статусы из выпадающего списка колонки. Лист «Сайты» только читается (в common.mjs).
//
// Нужны два секрета репозитория (Settings → Secrets and variables → Actions):
//   GOOGLE_SERVICE_ACCOUNT — JSON-ключ служебного аккаунта Google целиком;
//   SHEET_ID — ссылка на таблицу или её id. Таблицу надо открыть служебному аккаунту как редактору.

import path from 'node:path';
import { DATA, log, readJson } from './common.mjs';
import { SHEETS_API, api, connect, readRange } from './google.mjs';
import { FIRST_DATA_ROW, buildSheets, findHeaderRow, parseSites, placeColumns, SITES_SHEET, validateExport } from './sheet.mjs';

// 0 → A, 25 → Z, 26 → AA.
export function letter(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function planExport(sheets, info, grid) {
  const destination = new Map(info.sheets.map(({ properties }) => [properties.title, properties]));
  const titles = Object.keys(sheets);
  const missingSheets = titles.filter((title) => !destination.has(title));
  if (missingSheets.length) throw new Error(`Нет листов для выгрузки: ${missingSheets.join(', ')}`);

  const requests = [];
  const checks = [];
  for (const sheet of grid.sheets || []) {
    const title = sheet.properties.title;
    const rows = sheet.data?.[0]?.rowData || [];
    const spec = sheets[title];
    const cells = rows.map((r) => (r.values || []).map((c) => c.formattedValue || ''));
    const found = findHeaderRow(cells, spec.columns.map((c) => c.title));
    if (found < 0) throw new Error(`«${title}»: не найдена строка с заголовками`);
    const headers = cells[found];
    const first = Math.max(found + 2, FIRST_DATA_ROW); // номер первой строки данных в таблице
    const lists = (rows[first - 1]?.values || []).map((c) => (c.dataValidation?.condition?.values || []).map((v) => v.userEnteredValue));
    const { placed, missing, unknown } = placeColumns(spec, headers, lists);
    if (missing.length) throw new Error(`«${title}»: нет колонок ${missing.join(', ')}`);
    if (unknown.length) throw new Error(`«${title}»: значения не предусмотрены списком: ${unknown.join('; ')}`);
    const { sheetId, gridProperties: { rowCount } } = destination.get(title);
    if (spec.rows.length > rowCount - first + 1) throw new Error(`«${title}»: недостаточно строк для всех результатов`);
    const endColumn = Math.max(...placed.map(c => c.index));
    const last = Math.min(rowCount, first + spec.rows.length);
    checks.push({ title, first, last, columns: placed, range: `'${title}'!A${first}:${letter(endColumn)}${last}` });
    for (const { index, values } of placed) {
      requests.push({ updateCells: {
        range: { sheetId, startRowIndex: first - 1, endRowIndex: rowCount, startColumnIndex: index, endColumnIndex: index + 1 },
        fields: 'userEnteredValue',
        rows: values.map((v) => ({ values: [v == null || v === '' ? {} : {
          userEnteredValue: typeof v === 'number' ? { numberValue: v } : { stringValue: String(v) },
        }] })),
      } });
    }
    log(`«${title}»: строк ${spec.rows.length}, колонок ${placed.length}`);
  }

  // Меняются только значения ячеек: оформление, списки и правила цветов остаются как были.
  if (grid.sheets?.length !== titles.length) throw new Error('Не удалось прочитать все листы выгрузки');
  return { requests, checks };
}

export function verifyExport(checks, ranges) {
  if (ranges?.length !== checks.length) throw new Error('Не удалось прочитать все записанные листы');
  checks.forEach(({ title, first, last, columns }, i) => {
    const rows = ranges[i].values || [];
    for (const { index, values } of columns) {
      for (let j = 0; j <= last - first; j++) {
        if ((rows[j]?.[index] ?? '') !== (values[j] ?? '')) {
          throw new Error(`После выгрузки значение «${title}»!${letter(index)}${first + j} отличается от отчёта`);
        }
      }
    }
  });
}

export async function exportResults({ dryRun = false } = {}) {
  const { token, id } = await connect();
  const registry = parseSites(await readRange({ token, id }, `'${SITES_SHEET}'`), { strict: true });
  const reports = {
    registry,
    health: readJson(path.join(DATA, 'health', 'latest.json')),
    konget: readJson(path.join(DATA, 'konget', 'latest.json')),
    utp: readJson(path.join(DATA, 'utp', 'latest.json')),
  };
  validateExport(reports);
  const sheets = buildSheets(reports);

  // Только читаем: какие листы есть, заголовки (строка 1) и выпадающие списки (строка 2).
  const info = await api(token, `${SHEETS_API}/${id}?fields=${encodeURIComponent('properties.title,sheets.properties(sheetId,title,gridProperties.rowCount)')}`);
  const titles = Object.keys(sheets);
  // Шапка ищется в первых строках листа, данные пишутся под ней, но не выше строки 3 (B3).
  const ranges = titles.map((t) => `'${t}'!1:8`);
  const fields = 'sheets(properties.title,data(rowData.values(formattedValue,dataValidation.condition.values)))';
  const grid = await api(token, `${SHEETS_API}/${id}?${ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&')}&fields=${encodeURIComponent(fields)}`);

  const { requests, checks } = planExport(sheets, info, grid);
  if (dryRun) {
    log('Пробная выгрузка проверена. Рабочая таблица не изменена');
    return;
  }
  await api(token, `${SHEETS_API}/${id}:batchUpdate`, { requests });
  const query = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE' });
  for (const check of checks) query.append('ranges', check.range);
  const actual = await api(token, `${SHEETS_API}/${id}/values:batchGet?${query}`);
  verifyExport(checks, actual.valueRanges);
  log(`Готово: таблица «${info.properties.title}» обновлена`);
}

if (process.argv[1] === import.meta.filename) {
  exportResults({ dryRun: process.argv.includes('--dry-run') }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
