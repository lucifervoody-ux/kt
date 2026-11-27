// Общее для всех проверок: список сайтов, чтение и запись результатов, параллельный обход.

import fs from 'node:fs';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { assertUniqueIds, historyToDelete } from './lib.mjs';
import { HEALTH } from './checks.mjs';
import { connect, hasGoogle, readRange } from './google.mjs';
import { SITES_SHEET, parseSites, siteAddress } from './sheet.mjs';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const SCENARIOS = path.join(ROOT, 'scenarios');
export const DATA = path.join(ROOT, 'data');

export function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

// Сценарии сайтов (scenarios/*.yaml): где на сайте модели, цены и выгоды — нужны для сверки УТП.
export function loadScenarios() {
  return fs.readdirSync(SCENARIOS)
    .filter((f) => /\.ya?ml$/.test(f) && !f.startsWith('_'))
    .map((f) => ({ file: f, ...loadYaml(fs.readFileSync(path.join(SCENARIOS, f), 'utf8')) }));
}

// Список сайтов для проверки. Главный источник — лист «Сайты» Google-таблицы: его обновляет человек.
// Сценарий с тем же ID добавляет к сайту подсказки для сверки УТП. Если таблица не подключена
// (нет секретов) или лист пуст, берём сайты из сценариев.
export async function loadSites(onlyId) {
  const scenarios = loadScenarios();
  const byId = new Map(scenarios.map((s) => [String(s.id), s]));
  let sites = [];
  if ((process.env.GITHUB_ACTIONS === 'true' || process.env.GOOGLE_SERVICE_ACCOUNT || process.env.SHEET_ID) && !hasGoogle()) {
    throw new Error('Для проверки нужен актуальный лист «Сайты». Проверьте GOOGLE_SERVICE_ACCOUNT и SHEET_ID');
  }
  if (hasGoogle()) {
    const rows = parseSites(await readRange(await connect(), `'${SITES_SHEET}'`), { strict: true });
    log(`Лист «${SITES_SHEET}»: сайтов ${rows.length}`);
    sites = rows.map((r) => {
      // Сценарий подходит, только если в нём тот же сайт: ID в таблице могут не совпасть с тестовыми сценариями.
      const found = byId.get(String(r.id));
      const sc = found && host(found.site) === host(r.site) ? found : {};
      return { ...sc, ...r, konget_token: r.konget_token || sc.konget_token || '' };
    });
  }
  // Таблица не подключена: берём сохранённую копию листа «Сайты» (data/sites-copy.json).
  const copy = !sites.length ? readJson(path.join(DATA, 'sites-copy.json')) : null;
  if (!hasGoogle() && copy?.grid?.length) {
    const rows = parseSites(copy.grid, { strict: true });
    log(`Таблица не подключена, беру копию листа «${SITES_SHEET}» из data/sites-copy.json: сайтов ${rows.length}`);
    sites = rows.map((r) => {
      const found = byId.get(String(r.id));
      const sc = found && host(found.site) === host(r.site) ? found : {};
      return { ...sc, ...r, konget_token: r.konget_token || sc.konget_token || '' };
    });
  }
  if (!sites.length && !hasGoogle()) {
    log('Список сайтов берём из папки scenarios');
    sites = scenarios.filter((s) => s.site);
  }
  // onlyId: один ID или несколько через запятую («3,7,12»).
  const ids = onlyId ? new Set(String(onlyId).split(/[\s,;]+/).filter(Boolean)) : null;
  const selected = sites
    .filter((s) => s.active !== false)
    .filter((s) => !ids || ids.has(String(s.id)))
    .sort((a, b) => a.id - b.id);
  if (!selected.length) throw new Error('В реестре нет активных сайтов для выбранной проверки');
  if (ids && ids.size !== selected.length) throw new Error('Часть выбранных ID отсутствует или выключена в реестре');
  return selected;
}

// Сайты, которые проверка работы признала неработающими или заглушкой, не проверяем на скрипт Конгет и УТП,
// пока человек не откроет сайт сам и не поставит «Да» в колонке «Проверено вручную» листа «Сайты».
// Если сайт и правда не работает, ставят «Проверять: Нет».
export function splitUnverified(sites, health = readJson(path.join(DATA, 'health', 'latest.json'))) {
  // «Проверить вручную» не пропускаем: чаще всего это медленный или закрытый от зарубежных серверов сайт, он может открыться.
  const bad = new Set([HEALTH.down, HEALTH.stub]);
  // Остановленная проверка работы сохраняет неполный результат: по нему нельзя решать, кого пропускать.
  if (health?.stopped) {
    throw new Error(`Проверка работы сайтов была остановлена (проверено ${health.checked} из ${health.planned}). Запустите её заново до конца и дождитесь результата, потом запускайте эту проверку`);
  }
  // Старый или смешанный отчёт не доказывает, что сайт недоступен сейчас.
  if (health?.partial || (health?.checked_at && Date.now() - Date.parse(health.checked_at) > 24 * 3600_000)) {
    return { run: sites, skipped: [] };
  }
  const flagged = new Map((health?.sites || [])
    .filter((s) => bad.has(s.health)).map((s) => [String(s.id), s]));
  const run = [];
  const skipped = [];
  for (const s of sites) {
    const h = flagged.get(String(s.id));
    if (h && siteAddress(h.site) === siteAddress(s.site) && !s.verified) skipped.push({ site: s, health: h.health });
    else run.push(s);
  }
  if (skipped.length) log(`Пропущено сайтов, которые не прошли проверку работы: ${skipped.length}`);
  return { run, skipped };
}
export const SKIP_REASON = (health) => `Пропущен: на проверке работы статус «${health}». Повторно запустите проверку работы сайта после восстановления доступа`;

// «https://www.Tenet.ru/» → «tenet.ru».
export function host(site) {
  return String(site || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
}

// Прошлый результат сайта: тот же ID и тот же адрес. Если под этим ID теперь другой сайт, прошлого нет.
export function previousOf(prevById, site) {
  const prev = prevById.get(String(site.id));
  return prev && siteAddress(prev.site) === siteAddress(site.site) ? prev : undefined;
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

// Папка одной проверки: data/<kind>/latest.json и data/<kind>/history/<дата>.json.
export function store(kind, data = DATA) {
  const dir = path.join(data, kind);
  const history = path.join(dir, 'history');
  return {
    dir,
    latest: () => readJson(path.join(dir, 'latest.json')),
    // Прошлая проверка: самый свежий файл истории с датой раньше сегодняшней.
    previous(today, includeToday = false) {
      if (includeToday) {
        const latest = readJson(path.join(dir, 'latest.json'));
        if (latest?.date <= today && latest.sites?.length && !latest.partial && !latest.stopped) return latest;
      }
      if (!fs.existsSync(history)) return null;
      const files = fs.readdirSync(history).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
      for (const file of files) {
        const date = file.slice(0, 10);
        if (date > today || (!includeToday && date === today)) continue;
        const report = readJson(path.join(history, file));
        if (report?.sites?.length && !report.partial && !report.stopped) return report;
      }
      return null;
    },
    // Пишет итог и удаляет историю старше 3,5 месяцев.
    save(report) {
      assertUniqueIds(report.sites);
      fs.mkdirSync(history, { recursive: true });
      const text = JSON.stringify(report, null, 2);
      fs.writeFileSync(path.join(dir, 'latest.json'), text);
      if (!report.partial && !report.stopped) fs.writeFileSync(path.join(history, `${report.date}.json`), text);
      const dates = fs.readdirSync(history).map((f) => f.replace('.json', ''));
      for (const d of historyToDelete(dates, report.date)) {
        fs.rmSync(path.join(history, `${d}.json`));
        log(`Удалена старая проверка ${d}`);
      }
    },
  };
}

// Сайты, которые проверили не сейчас (проверка одного сайта или остановка кнопкой),
// берём из прошлого итога, чтобы ничего не потерять.
export function keepUnchecked(latest, results) {
  const done = new Set(results.map((r) => String(r.id)));
  return [...(latest?.sites || []).filter((s) => !done.has(String(s.id))), ...results];
}

// Обходит сайты по несколько одновременно. onStop вызывается, если проверку остановили кнопкой:
// GitHub сначала посылает сигнал и даёт несколько секунд, успеваем сохранить собранное.
export async function runQueue(items, parallel, handle, onStop) {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      onStop();
      process.exit(0);
    });
  }
  const queue = [...items];
  async function worker() {
    while (queue.length) await handle(queue.shift());
  }
  await Promise.all(Array.from({ length: parallel }, worker));
}

export function siteBase(site) {
  return {
    id: site.id, company: site.company || '', responsible: site.responsible || '', site: site.site, brand: site.brand || '',
  };
}

export function siteUrl(site) {
  return /^https?:\/\//.test(site.site) ? site.site : `https://${site.site}`;
}
