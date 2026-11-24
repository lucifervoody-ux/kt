// Чистые функции проверок «Работает ли сайт» и «Есть ли скрипт Конгет».
// Здесь нет браузера, поэтому всё легко проверить тестами (collector/checks.test.mjs).

export const HEALTH = {
  ok: 'Работает',
  slow: 'Работает медленно',
  stub: 'Заглушка',
  down: 'Не работает',
  manual: 'Проверить вручную',
};
export const HEALTH_ORDER = [HEALTH.down, HEALTH.manual, HEALTH.stub, HEALTH.slow, HEALTH.ok];

export const KONGET = {
  ok: 'Скрипт есть',
  wrong: 'Токен не тот',
  noToken: 'Скрипт без токена',
  manual: 'Проверить вручную',
  missing: 'Скрипта нет',
  down: 'Сайт не открылся',
};
export const KONGET_ORDER = [KONGET.missing, KONGET.wrong, KONGET.noToken, KONGET.manual, KONGET.down, KONGET.ok];

export const SLOW_SECONDS = 10;
export const PROTECTED_CODES = [401, 403, 429];
const MIN_TEXT = 80; // на живой странице дилера текста точно больше

// Страница-заглушка вместо сайта: «сайт в разработке», «домен продаётся», хостинг не оплачен.
const STUB = [
  /сайт\s+(?:на\s+реконструкции|не\s+запущен|создан,?\s+но\s+ещ[её]\s+не\s+запущен)/i,
  /сайт\s+(находится\s+)?в\s+разработке/i,
  /сайт\s+временно\s+(не\s+)?(доступен|работает)/i,
  /ведутся\s+технические\s+работы/i,
  /домен\s+.{0,40}(продается|продаётся|припаркован|не\s+делегирован)/i,
  /(срок\s+регистрации|оплата\s+хостинга|аккаунт\s+заблокирован)/i,
  /under\s+construction|domain\s+(is\s+)?for\s+sale|this\s+domain\s+is\s+parked/i,
  /index\s+of\s+\//i,
];

// Защита сайта не пускает проверку (часто закрыт доступ из-за рубежа, откуда работает GitHub).
// Людям сайт может открываться, но проверить его программа не может.
export const BLOCKED = /визит заблокирован|access blocked|web\s+page\s+blocked|access\s+denied|403\s+forbidden|доступ\s+(запрещ[её]н|ограничен)|подтвердите,?\s+что\s+вы\s+не\s+робот|checking\s+your\s+browser/i;

// Итог проверки сайта по тому, что вернул браузер.
// Ошибки, после которых точно ясно, что сайт не работает: домена нет или сервер сам отказал.
// Остальное (долго не отвечал, сертификат, обрыв) может быть закрытым доступом из-за рубежа.
export const SURE_DOWN = /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE/;

// Переход между поддоменами важен для атрибуции. Только www равнозначен исходному адресу.
export function baseDomain(address = '') {
  let h = String(address).trim();
  try { h = new URL(/^https?:/i.test(h) ? h : `https://${h}`).hostname; } catch { /* оставляем как есть */ }
  return h.toLowerCase().replace(/^www\./, '');
}

export function healthVerdict({ error, status, seconds, text = '', title = '', site = '', finalUrl = '' }) {
  if (error) {
    if (SURE_DOWN.test(error)) return { health: HEALTH.down, reason: error };
    // Сертификат просрочен или выдан на другой адрес: это видят и посетители (браузер пишет «Подключение не защищено»).
    if (/ERR_CERT_DATE_INVALID/.test(error)) return { health: HEALTH.manual, reason: 'Сертификат сайта просрочен: браузер показывает посетителям «Подключение не защищено». Нужно продлить сертификат' };
    if (/ERR_CERT_/.test(error)) return { health: HEALTH.manual, reason: `Сертификат сайта недействителен (${error.match(/ERR_CERT_\w+/)[0]}): браузер показывает посетителям «Подключение не защищено»` };
    return { health: HEALTH.manual, reason: `Не открылся с серверов проверки (${error}). Людям сайт может открываться, проверьте вручную` };
  }
  if (/^https?:\/\/blocked\.botfaqtor\.ru(?:[/:]|$)/i.test(finalUrl) || BLOCKED.test(`${title}\n${text.slice(0, 2000)}`)) {
    return { health: HEALTH.manual, reason: 'Защита сайта не пустила проверку. Людям сайт может открываться, проверьте вручную' };
  }
  // 401, 403 и 429 чаще всего значат защиту от роботов: людям сайт открывается.
  if (PROTECTED_CODES.includes(status)) {
    return { health: HEALTH.manual, reason: `Сайт ответил кодом ${status}: похоже на защиту от роботов. Людям сайт может открываться, проверьте вручную` };
  }
  if (status >= 400) return { health: HEALTH.down, reason: `Сайт ответил ошибкой ${status}` };
  // Редирект на другой домен (например, филиал ведёт на сайт группы) — это нормально, просто отмечаем.
  let redirect = '';
  if (site && finalUrl && baseDomain(site) !== baseDomain(finalUrl)) {
    let to = finalUrl;
    try { to = new URL(finalUrl).hostname; } catch { /* как есть */ }
    redirect = `Перенаправляет на ${to}`;
  }
  const all = `${title}\n${text}`;
  const stub = STUB.find((re) => re.test(all));
  if (stub) return { health: HEALTH.stub, reason: `На странице: «${all.match(stub)[0]}»` };
  if (text.replace(/\s+/g, ' ').trim().length < MIN_TEXT) return { health: HEALTH.manual, reason: 'В браузере почти нет видимого текста. Открытие сайта требует ручной проверки' };
  if (!title.trim() && !(/дилер/i.test(text) && /(?:\+7|8\s*\(|ИНН\s*\d{10,12})/i.test(text) && /модел|автомобил|выгод/i.test(text))) return { health: HEALTH.manual, reason: 'У страницы нет заголовка: возможно, это проверка на робота. Проверьте вручную' };
  if (seconds > SLOW_SECONDS) return { health: HEALTH.slow, reason: [`Открывался ${Math.round(seconds)} с`, redirect].filter(Boolean).join('. ') };
  return { health: HEALTH.ok, reason: redirect };
}

// Движок сайта: по нему подбираем общий шаблон для сверки УТП (у сайтов на одном движке
// одинаковая разметка). Ищем характерные следы в коде страницы, иначе берём <meta name="generator">.
const ENGINES = [
  ['Perxis', /perxis/i],
  ['TradeDealer', /tradedealer\.ru|\/dws_builds\//i],
  ['1С-Битрикс', /\/bitrix\/(?:js|templates|cache|components|tools)\//i],
  ['Tilda', /tildacdn|data-tilda-/i],
  ['WordPress', /\/wp-content\/|\/wp-includes\//i],
  ['Joomla', /\/media\/jui\/|content=["']Joomla/i],
  ['Drupal', /drupal-settings-json|\/sites\/default\/files\//i],
  ['MODX', /content=["']MODX|\/assets\/components\/minishop/i],
  ['OpenCart', /catalog\/view\/theme\//i],
  ['Wix', /wixstatic\.com|static\.parastorage\.com/i],
  ['Каскад', /--siteUi:\s*kaskad/i],
  ['УАЗ-дилер', /available-cars-item|main-cars-nav-item/],
  ['Nuxt', /window\.__NUXT__|\/_nuxt\//],
  ['Next.js', /__NEXT_DATA__|\/_next\/static\//],
];

// Платформы, где у дилеров адреса вида дилер.платформа.ru: движок видно по адресу.
const HOSTS = [
  ['Сайты LADA', /\.lada\.ru$/i],
  ['Платформа rqch.ru', /\.rqch\.ru$/i],
];

export function detectEngine(html = '', url = '') {
  const hostname = (() => {
    try { return new URL(url).hostname; } catch { return ''; }
  })();
  const byHost = HOSTS.find(([, re]) => re.test(hostname));
  if (byHost) return byHost[0];
  const found = ENGINES.find(([, re]) => re.test(html));
  if (found) return found[0];
  const generator = html.match(/<meta[^>]+name=["']generator["'][^>]*content=["']([^"']+)/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']generator["']/i);
  return generator ? generator[1].trim().slice(0, 40) : 'Не определён';
}

// Токен Конгет: //app.konget.ru/inject?token=538e1215043c412b9cfcff11319094a9.
// На всякий случай понимает и другие записи: injectToken=…, inject_token: "…".
const TOKEN = /inject(?:\?|[\s_-])?token["']?\s*[:=]\s*["']?([A-Za-z0-9_-]{6,})/gi;

export function findTokens(text) {
  return [...new Set([...String(text || '').matchAll(TOKEN)].map((m) => m[1]))];
}

// Контейнер тегов (Google Tag Manager и подобные): скрипт Конгет может лежать в нём,
// и в коде сайта его не видно.
const CONTAINER = /googletagmanager\.com|gtm\.js|\bGTM-[A-Z0-9]{4,}|tagmanager/i;

// Как скрипт стоит в коде сайта.
//   «обычный» — <script src="//app.konget.ru/inject?token=…">;
//   «отложенный» — ссылка внутри кода, скрипт добавляется через N секунд (setTimeout);
//   «через контейнер» — в коде сайта его нет, но браузер его загрузил.
function kindOf(html, token) {
  const at = html.indexOf(token);
  if (at < 0) return 'через контейнер';
  const before = html.slice(Math.max(0, at - 200), at);
  return /<script[^>]*\ssrc\s*=\s*["'][^"']*$/i.test(before) ? 'обычный' : 'отложенный';
}

// html — код страницы, как его отдал сервер; dom — код после загрузки и ожидания; requests — адреса всех файлов, которые загрузил браузер
// (включая те, что появились через несколько секунд или из контейнера).
export function kongetVerdict({ error, html = '', dom = '', bundles = '', scriptsUnavailable = false, requests = [], expected = '', status = 0 }) {

  const endpoint = /^(?:https?:)?\/\/app\.konget\.ru\/inject(?:[?#]|$)/i;
  const loaded = requests.filter((u) => endpoint.test(u));
  const inCode = [...`${html}\n${dom}\n${bundles}`.matchAll(/(?:https?:)?\/\/[^\s"'<>]+/gi)]
    .map((m) => m[0].replace(/&amp;/gi, '&')).filter((u) => endpoint.test(u));
  const tokens = [...new Set([...loaded, ...inCode].map((u) => new URL(u, 'https://app.konget.ru').searchParams.get('token')).filter((t) => /^[A-Za-z0-9_-]{6,}$/.test(t || '')))];
  const where = loaded[0] || inCode[0] || '';
  const container = CONTAINER.test(`${html}\n${dom}`) || requests.some((u) => CONTAINER.test(u));
  if (!loaded.length && !inCode.length) {
    if (error) return { konget: KONGET.down, tokens: [], reason: error };
    // Сайт ответил защитой от роботов: настоящей страницы программа не видела, «скрипта нет» утверждать нельзя.
    if (PROTECTED_CODES.includes(status) || BLOCKED.test(dom.replace(/<[^>]+>/g, ' ').slice(0, 2000))) {
      return { konget: KONGET.manual, tokens, reason: `Сайт ответил защитой от роботов${status ? ` (код ${status})` : ''}, страницу программа не увидела. Проверьте вручную` };
    }
    if (scriptsUnavailable) return { konget: KONGET.manual, tokens, reason: 'Часть скриптов не загрузилась. Установку Конгет проверить полностью не удалось' };
    return container
      ? { konget: KONGET.manual, tokens, reason: 'Скрипт не найден, но на сайте есть контейнер тегов (например, Google Tag Manager). Скрипт может лежать в нём, проверьте сами' }
      : { konget: KONGET.missing, tokens, reason: 'В коде сайта и в загруженных файлах нет app.konget' };
  }
  if (!tokens.length) return { konget: KONGET.noToken, tokens, where, reason: 'Конгет на сайте есть, а token не нашёлся' };
  const kind = !loaded.length && bundles.includes(tokens[0]) && !html.includes(tokens[0]) ? 'в JavaScript сайта' : kindOf(html, tokens[0]);
  if (expected && !tokens.includes(String(expected))) {
    return { konget: KONGET.wrong, tokens, kind, where, reason: `Ждали ${expected}, на сайте ${tokens.join(', ')}` };
  }
  return { konget: KONGET.ok, tokens, kind, where, reason: '' };
}

// Сравнение с прошлой проверкой: что поменялось у сайта.
export function changedSince(prev, curr, field) {
  if (!prev) return '';
  return prev[field] !== curr[field] ? `Было: ${prev[field]}` : '';
}

export function sortBy(order, field) {
  return (sites) => [...sites].sort((a, b) => order.indexOf(a[field]) - order.indexOf(b[field]) || a.id - b.id);
}

export function countBy(sites, field, names) {
  const out = Object.fromEntries(names.map((n) => [n, 0]));
  for (const s of sites) out[s[field]] = (out[s[field]] || 0) + 1;
  return out;
}
