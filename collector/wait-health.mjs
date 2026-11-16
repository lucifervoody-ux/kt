// Перед проверкой Конгета и УТП ждём, пока закончится идущая «Работа сайтов»: по её результату решаем, какие сайты пропускать.
// Нужны переменные GITHUB_TOKEN и GITHUB_REPOSITORY (есть в запуске GitHub Actions).
import { log } from './common.mjs';

const WAIT_MINUTES = Number(process.env.WAIT_MINUTES) || 90;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function running() {
  const base = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/health.yml/runs`;
  let count = 0;
  for (const status of ['queued', 'in_progress']) {
    const res = await fetch(`${base}?status=${status}&per_page=5`, {
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
    count += (await res.json()).total_count || 0;
  }
  return count;
}

async function main() {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) return;
  const until = Date.now() + WAIT_MINUTES * 60_000;
  let told = false;
  while (Date.now() < until) {
    let n;
    try {
      n = await running();
    } catch (e) {
      log(`Не смог узнать, идёт ли проверка работы (${e.message}), продолжаю без ожидания`);
      return;
    }
    if (!n) return;
    if (!told) log('Идёт «Работа сайтов», жду её окончания');
    told = true;
    await sleep(30_000);
  }
  log('Проверка работы всё ещё идёт после долгого ожидания, продолжаю с тем, что есть');
}

main();
