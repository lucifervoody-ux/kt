// Раскладка результатов по листам Google-таблицы (кнопка 4): какие значения в какие колонки.
// Оформление, списки и цвета таблицы настраивает человек, программа их не трогает:
// она находит свои колонки по заголовкам и пишет только значения, выбирая их из списков колонки.
// Здесь нет обращения к Google, поэтому это легко проверить тестами. Запись в таблицу — в export.mjs.

import { CHANGE } from './lib.mjs';
import { HEALTH, KONGET } from './checks.mjs';

const yes = (v) => (v ? 'Да' : 'Нет');

// Колонка: заголовок, под которым программа ищет её в таблице.
const col = (title) => ({ title });

// Что выгружаем: имя листа → { columns, rows }.
const workState = (h) => ([HEALTH.ok, HEALTH.slow].includes(h) ? 'Работает' : h === HEALTH.manual ? HEALTH.manual : 'Не работает');

export function buildSheets({ health, konget, utp }) {
  const byId = (report) => new Map((report?.sites || []).map((s) => [String(s.id), s]));
  const h = byId(health);
  const k = byId(konget);
  const u = byId(utp);
  const ids = [...new Set([...h.keys(), ...k.keys(), ...u.keys()])].sort((a, b) => Number(a) - Number(b));

  // «Сводка»: одна строка на сайт, все три проверки рядом. Проблемные сайты сверху.
  const summary = ids.map((id) => {
    const site = h.get(id) || k.get(id) || u.get(id);
    const hs = h.get(id);
    const ks = k.get(id);
    const us = u.get(id);
    const problems = [hs?.health && hs.health !== HEALTH.ok, ks?.konget && ks.konget !== KONGET.ok,
      us?.change && [CHANGE.error, CHANGE.check].includes(us.change)].filter(Boolean).length;
    return {
      problems,
      row: [
        Number(id), site.company || '', site.site, site.brand || '', site.responsible || '',
        hs?.health || '', ks?.konget || '', ks && ks.konget !== KONGET.down ? yes(ks.tokens?.length) : '', us?.change || '',
        (us?.changes || []).join('; '),
        // Если сайт не открылся, причина у проверки работы и у скрипта одна: пишем её один раз.
        [...new Set([hs?.reason, ks?.konget === KONGET.down && hs?.reason ? '' : ks?.reason, us?.comment].filter(Boolean))].join('; '),
      ],
    };
  }).sort((a, b) => b.problems - a.problems || a.row[0] - b.row[0]).map((x) => x.row);

  const sites = (report) => report?.sites || [];

  return {
    'Сводка': {
      columns: [
        col('ID'), col('Компания'), col('Сайт'), col('Бренд'), col('Ответственный'),
        col('Сайт работает'), col('Скрипт Конгет'), col('Токен есть'), col('УТП'), col('Что изменилось'), col('Комментарий'),
      ],
      rows: summary,
    },
    'Работа сайтов': {
      columns: [
        col('ID'), col('Сайт'), col('Статус'), col('Код ответа'), col('Работоспособность'), col('Причина'), col('Было'),
      ],
      rows: sites(health).map((s) => [
        s.id, s.site, s.health, s.code ?? '', workState(s.health),
        s.reason || '', (s.was || '').replace('Было: ', ''),
      ]),
    },
    'Скрипт Конгет': {
      columns: [
        col('ID'), col('Сайт'), col('Статус'), col('Как стоит'), col('Пояснение'), col('Было'),
      ],
      rows: sites(konget).map((s) => [
        s.id, s.site, s.konget, s.kind || '', s.reason || '',
        (s.was || '').replace('Было: ', ''),
      ]),
    },
    // «УТП»: одна строка — один сайт. Есть ли изменения с прошлого сбора и какие.
    'УТП': {
      columns: [
        col('ID'), col('Сайт'), col('Бренд'), col('Статус'), col('Изменения'), col('Что изменилось'),
        col('Комментарий'),
      ],
      rows: sites(utp).map((s) => [
        s.id, s.site, s.brand || '', s.change,
        s.change === CHANGE.changed ? 'Да' : [CHANGE.same, CHANGE.first].includes(s.change) ? 'Нет' : '',
        s.change === CHANGE.changed ? (s.changes || []).join('; ') : '', s.comment || '',
      ]),
    },
  };
}

// Значения листа: строка 1 — заголовки колонок, дальше данные.
export function sheetValues({ columns, rows }) {
  return [columns.map((c) => c.title), ...rows];
}

// Если в выпадающем списке колонки нет нашего статуса, пишем ближайший из тех, что есть.
export const FALLBACK = {
  [KONGET.wrong]: KONGET.manual,
  [KONGET.noToken]: KONGET.manual,
  [HEALTH.manual]: 'Не работает',
};

const norm = (v) => String(v ?? '').trim().toLowerCase();

// Данные в листах начинаются не выше 3-й строки (B3): выше человек держит шапку и оформление.
export const FIRST_DATA_ROW = 3;
const HEADER_SEARCH_ROWS = 6;

// Строка заголовков — та из первых строк листа, где больше всего наших заголовков (нужно хотя бы два).
// rows — массив строк листа сверху (индексы с нуля). Возвращает индекс строки или -1.
export function findHeaderRow(rows, titles) {
  const want = new Set(titles.map(norm));
  let best = -1;
  let bestCount = 1;
  rows.slice(0, HEADER_SEARCH_ROWS).forEach((r, i) => {
    const n = (r || []).filter((c) => want.has(norm(c))).length;
    if (n > bestCount) {
      best = i;
      bestCount = n;
    }
  });
  return best;
}

// Раскладывает колонки листа по заголовкам, которые стоят в таблице (строка 1).
// Сначала точное совпадение, потом по началу: «Статус» найдёт «Статус на 2026-10-29».
// lists — значения выпадающих списков по номеру колонки таблицы: значение не из списка
// заменяем по FALLBACK. Возвращает колонки { index, title, values }, ненайденные заголовки
// и значения, которых нет в списке.
export function placeColumns({ columns, rows }, headers, lists = []) {
  const taken = new Set();
  const found = new Array(columns.length).fill(-1);
  const match = (test) => columns.forEach((c, i) => {
    if (found[i] >= 0) return;
    const at = headers.findIndex((h, j) => !taken.has(j) && norm(h) && test(norm(h), norm(c.title)));
    if (at >= 0) {
      found[i] = at;
      taken.add(at);
    }
  });
  match((h, t) => h === t);
  match((h, t) => h.startsWith(`${t} `) || t.startsWith(`${h} `));

  const unknown = new Set();
  const placed = [];
  columns.forEach((c, i) => {
    const index = found[i];
    if (index < 0) return;
    const list = lists[index];
    const values = rows.map((r) => {
      const v = r[i];
      if (!list?.length || v === '' || v == null || list.includes(v)) return v;
      if (list.includes(FALLBACK[v])) return FALLBACK[v];
      unknown.add(`${headers[index]}: ${v}`);
      return v;
    });
    placed.push({ index, title: headers[index], values });
  });
  return { placed, missing: columns.filter((_, i) => found[i] < 0).map((c) => c.title), unknown: [...unknown] };
}

// Лист «Сайты» — список сайтов, по которому работают все проверки. Его заполняет человек, программа только читает.
export const SITES_SHEET = 'Сайты';

// Лист «Сайты» целиком (строка 1 — заголовки) → список сайтов для проверок.
// Колонки ищем по заголовкам, поэтому их можно переставлять и удалять ненужные.
// Пустые строки и строки без ID или адреса пропускаем; «Проверять: Нет» — сайт временно не проверяем.
export function parseSites(grid) {
  const found = findHeaderRow(grid, ['ID', 'Сайт', 'Бренд', 'Компания', 'Проверять']);
  const at0 = found < 0 ? 0 : found;
  const header = grid[at0] || [];
  const rows = grid.slice(at0 + 1);
  const at = (title) => header.findIndex((h) => norm(h) === norm(title));
  const idx = {
    id: at('ID'), company: at('Компания'), site: at('Сайт'), brand: at('Бренд'), responsible: at('Ответственный'),
    active: at('Проверять'), token: at('Токен Конгет'), verified: at('Проверено вручную'), utp: at('Проверять УТП'),
  };
  const get = (r, i) => {
    const v = i < 0 ? '' : String(r[i] ?? '').trim();
    return v === 'None' ? '' : v;
  };
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const id = Number(get(r, idx.id));
    const site = get(r, idx.site).replace(/\/+$/, '');
    if (!id || !site || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      company: get(r, idx.company),
      site,
      brand: get(r, idx.brand),
      responsible: get(r, idx.responsible),
      active: get(r, idx.active).toLowerCase() !== 'нет',
      konget_token: get(r, idx.token),
      verified: get(r, idx.verified).toLowerCase() === 'да',
      // «Проверять УТП: Нет» — сайт остаётся в проверке работы и Конгета, но УТП не сверяем.
      utp: get(r, idx.utp).toLowerCase() !== 'нет',
    });
  }
  return out;
}
