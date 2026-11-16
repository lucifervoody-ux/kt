// Разбор лендингов без шаблона с помощью ИИ.
// Берёт текст главной страницы, просит модель выписать модели, цены «от» и выгоды «до»,
// и принимает только те числа, которые действительно стоят на странице (защита от выдумок модели).
//
// Подходит любой сервис с OpenAI-совместимым адресом. Настройки (секреты и переменные репозитория):
//   AI_API_KEY   — ключ сервиса. Без него ИИ не используется, остаётся общая цена по сайту;
//   AI_BASE_URL  — адрес сервиса (по умолчанию Gemini: https://generativelanguage.googleapis.com/v1beta/openai);
//   AI_MODEL     — название модели (по умолчанию gemini-2.5-flash).

const DEFAULT_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const MAX_CHARS = 14_000;

export const aiConfigured = (env = process.env) => Boolean(env.AI_API_KEY);

// Из текста страницы оставляем самое важное: заголовки и строки с суммами и выгодами, остальное не нужно.
export function trimPageText(text, max = MAX_CHARS) {
  const lines = String(text || '').replace(/[   ]/g, ' ').split('\n').map((l) => l.trim()).filter(Boolean);
  const keep = lines.filter((l) => /₽|руб|выгод|скидк|от\s*\d|\d{3}\s*\d{3}|модель|комплектац/i.test(l) || l.length < 40);
  const out = [];
  let size = 0;
  for (const l of [...new Set(keep)]) {
    if (size + l.length > max) break;
    out.push(l);
    size += l.length + 1;
  }
  return out.join('\n');
}

export function buildPrompt({ brand, site, pageText }) {
  return [
    `Это текст главной страницы сайта автодилера (${site}, бренд: ${brand || 'не указан'}).`,
    'Выпиши все автомобили (модели), для которых на странице указана цена «от» в рублях.',
    'Для каждой модели укажи: model (название модели), price (самая низкая цена на странице для этой модели, число в рублях),',
    'max_benefit (самая большая выгода или скидка в рублях для этой модели или общая для сайта, число; если не указана, null).',
    'Не включай ежемесячные платежи, первоначальный взнос и цены запчастей. Числа бери только те, что есть в тексте. Ничего не выдумывай.',
    'Ответь только JSON-массивом без пояснений, например: [{"model":"TIGGO 9","price":3635000,"max_benefit":500000}].',
    'Если подходящих цен нет, ответь [].',
    '',
    'Текст страницы:',
    pageText,
  ].join('\n');
}

const digits = (n) => String(Math.round(Number(n))).replace(/\D/g, '');

// Принимаем ответ модели: JSON-массив, у каждой модели число должно стоять на странице.
export function parseAiAnswer(answer, pageText, { minPrice = 300_000 } = {}) {
  const json = String(answer || '').match(/\[[\s\S]*\]/)?.[0];
  if (!json) return [];
  let list;
  try {
    list = JSON.parse(json);
  } catch {
    return [];
  }
  const flat = String(pageText || '').replace(/[\s   ]/g, '');
  const onPage = (n) => Number.isFinite(Number(n)) && Number(n) > 0 && flat.includes(digits(n));
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const model = String(x?.model ?? '').trim();
    const price = Number(x?.price);
    if (!model || !(price >= minPrice) || !onPage(price)) continue;
    const benefit = x.max_benefit == null ? '-' : (onPage(x.max_benefit) ? Math.round(Number(x.max_benefit)) : '-');
    out.push({ model, price: Math.round(price), max_benefit: benefit });
  }
  return out;
}

// Бесплатные модели OpenRouter меняются: список берём у сервиса в момент запуска и выбираем самые подходящие.
const PREFER = /gemini|llama-3\.3|llama-4|qwen|deepseek|mistral|gpt-oss|gemma/i;
export function pickFreeModels(list, count = 6) {
  // Исключаем модели, которые работают только в «агентских» средах (отвечают 403).
  const free = (list || []).filter((m) => String(m.id).endsWith(':free') && (m.context_length || 0) >= 16_000 && !/inkling|thinkingmachines/i.test(m.id));
  const score = (m) => (PREFER.test(m.id) ? 1_000_000 : 0) + (m.context_length || 0) / 1000;
  return free.sort((a, b) => score(b) - score(a)).slice(0, count).map((m) => m.id);
}

async function modelList(base, env, fetchImpl) {
  if (env.AI_MODEL && env.AI_MODEL !== 'auto-free') return [env.AI_MODEL];
  if (/openrouter/i.test(base) || env.AI_MODEL === 'auto-free') {
    const res = await fetchImpl(`${base}/models`, { headers: { authorization: `Bearer ${env.AI_API_KEY}` } });
    const found = res.ok ? pickFreeModels((await res.json()).data) : [];
    if (found.length) return found;
    throw new Error('Не нашлось бесплатных моделей у сервиса');
  }
  return [DEFAULT_MODEL];
}

// Адрес сервиса: из переменной AI_BASE_URL, а для ключей OpenRouter (sk-or-…) он известен сам.
export function baseUrl(env) {
  const given = env.AI_BASE_URL || (String(env.AI_API_KEY || '').startsWith('sk-or-') ? 'https://openrouter.ai/api/v1' : DEFAULT_URL);
  return given.replace(/\/+$/, '');
}

export async function askAi({ brand, site, pageText }, { env = process.env, fetchImpl = fetch } = {}) {
  const base = baseUrl(env);
  const send = (model) => fetchImpl(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.AI_API_KEY}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [{ role: 'user', content: buildPrompt({ brand, site, pageText }) }],
    }),
  });
  const wait = (i) => new Promise((r) => setTimeout(r, (env.AI_RETRY_MS ? Number(env.AI_RETRY_MS) : 20_000) * i));
  let lastError = 'нет ответа';
  const errors = [];
  // Пробуем модели по очереди: у бесплатных бывают перебои. При лимите (429) ждём и повторяем.
  for (const model of await modelList(base, env, fetchImpl)) {
    let res = await send(model);
    for (let i = 1; i <= 2 && res.status === 429; i += 1) {
      await wait(i);
      res = await send(model);
    }
    if (!res.ok) {
      const body = (await res.text?.().catch(() => '') ?? '').replace(/\s+/g, ' ').slice(0, 160);
      errors.push(`${model}: ${res.status}${body ? ` ${body}` : ''}`);
      lastError = `ИИ ответил ошибкой ${errors.length > 1 ? errors.map((e) => e.slice(0, 90)).join(' | ') : errors[0]}`;
      continue;
    }
    const data = await res.json();
    const answer = data?.choices?.[0]?.message?.content;
    if (answer) return parseAiAnswer(answer, pageText);
    lastError = 'ИИ вернул пустой ответ';
  }
  throw new Error(lastError);
}
