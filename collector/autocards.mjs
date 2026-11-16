// Автопоиск карточек моделей на странице, без селекторов.
// Нужен для сайтов, у движка которых нет своего шаблона, и для новых сайтов в будущем.
//
// Как ищет: находит на странице строки с ценой («от 2 219 990 ₽»), поднимается от каждой вверх
// до блока, у которого рядом есть такие же блоки (тот же тег и класс у соседей): это карточка.
// Из всех групп карточек берёт самую большую. Название модели — заголовок карточки
// (h1–h6, элемент с title/name в классе, strong) или её первая строка.
//
// Функция выполняется в браузере (page.evaluate), поэтому внутри нет импортов.
export function findModelCards(opts = {}) {
  const PRICE = /\d{1,3}(?:[\s  ]\d{3}){2}\s*(?:₽|руб|р\.)/i;
  const maxCardText = opts.maxCardText || 700;
  const minCards = opts.minCards || 2;
  const text = (el) => (el.innerText || el.textContent || '').replace(/[  ]/g, ' ');
  const visible = (el) => {
    const r = el.getBoundingClientRect?.();
    return !r || r.width > 0 || r.height > 0 || !el.isConnected;
  };
  const sig = (el) => `${el.tagName}.${(el.getAttribute('class') || '').trim().split(/\s+/)[0] || ''}`;

  // 1) Самые глубокие элементы с ценой.
  const all = [...document.body.querySelectorAll('*')].filter((el) => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName));
  const priceEls = all.filter((el) => {
    const t = text(el);
    return t.length < 120 && PRICE.test(t) && ![...el.children].some((c) => PRICE.test(text(c)));
  });

  // 2) От цены вверх до карточки: у родителя есть ещё хотя бы один ребёнок с той же подписью.
  const groups = new Map();
  for (const p of priceEls) {
    let n = p;
    for (let depth = 0; depth < 8 && n && n.parentElement && n !== document.body; depth += 1, n = n.parentElement) {
      const parent = n.parentElement;
      const s = sig(n);
      const same = [...parent.children].filter((c) => sig(c) === s);
      if (same.length >= minCards && text(n).length <= maxCardText && s.split('.')[1] !== '') {
        const key = `${sig(parent)}>${s}`;
        if (!groups.has(key)) groups.set(key, { parent, cards: new Set() });
        groups.get(key).cards.add(n);
        break;
      }
      if (text(n).length > maxCardText) break;
    }
  }
  if (!groups.size) return [];

  // 3) Самая большая группа карточек (при равенстве — та, что выше на странице).
  const ranked = [...groups.values()].filter((g) => g.cards.size >= minCards && [...g.cards].some(visible))
    .sort((a, b) => b.cards.size - a.cards.size);
  if (!ranked.length) return [];

  const NAME_SEL = 'h1, h2, h3, h4, h5, h6, [class*="title" i], [class*="name" i], [class*="model" i], strong, b';
  const BAD_NAME = /(₽|руб|\d{3}\s\d{3}|выгод|скидк|кредит|в наличии|подробнее|узнать|купить|оставить|заявк|записат|цена|от\s\d|мм\)|разгон|двигател|привод|^передний|^полный)/i;
  // Карточки комплектаций, характеристик и т.п. — не модели.
  const BAD_GROUP = /complect|komplekt|grade|trim|package|spec|feature|option|param|char|benefit|advantage|review|news/i;
  // Двигатель и коробка в названии («Tiggo 4 Pro 1.5 CVT (113 л.с.) 2024») отрезаем: остаётся модель.
  const shortName = (s) => s.replace(/\s+\d[.,]\d\s*(л\b|t\b|tgdi|tgi|hyb|at\b|mt\b|amt|cvt|dct|\().*$/i, '')
    .replace(/\s+\(\d+\s*л\.?\s*с.*$/i, '').replace(/\s+20\d\d\s*$/, '').trim();
  // Название модели не начинается с цифры или строчной буквы и не похоже на лозунг.
  const good = (s) => s.length >= 2 && !/[!?]/.test(s) && !/^[\d.,]/.test(s) && !/^[а-яё]/.test(s) && !/\s(л|л\.с\.)$/.test(s);
  const nameOf = (card) => {
    const named = [...card.querySelectorAll(NAME_SEL)].map(text).map((s) => s.split('\n').map((l) => l.trim()).find(Boolean) || '')
      .find((s) => s.length >= 2 && s.length <= 80 && !BAD_NAME.test(s));
    if (named && good(shortName(named))) return { name: shortName(named), strong: true };
    const first = text(card).split('\n').map((l) => l.trim()).find((l) => l.length >= 2 && l.length <= 60 && !BAD_NAME.test(l));
    return { name: first && good(shortName(first)) ? shortName(first) : '', strong: false };
  };
  const scored = ranked.map((g) => {
    const cards = [...g.cards].map((c) => ({ c, ...nameOf(c) })).filter((x) => x.name);
    const names = new Set(cards.map((x) => x.name.toLowerCase()));
    const cls = [...g.cards][0].getAttribute('class') || '';
    let score = names.size + cards.filter((x) => x.strong).length * 0.5;
    if (BAD_GROUP.test(cls)) score *= 0.3;
    // Модели называются коротко; длинные названия — это объявления склада или комплектации.
    const avg = cards.reduce((a, x) => a + x.name.length, 0) / (cards.length || 1);
    if (avg > 30) score *= 0.5;
    return { cards, score };
  }).filter((g) => g.cards.length >= minCards).sort((a, b) => b.score - a.score);

  const out = [];
  const seen = new Set();
  for (const g of scored.slice(0, 1)) {
    for (const { c, name } of g.cards) {
      const key = name.toLowerCase().replace(/\s+/g, ' ');
      const t = text(c);
      const prev = out.find((o) => o.key === key);
      // Одна модель в нескольких карточках (склад): склеиваем текст, цена и выгода выберутся из всех.
      if (prev) { prev.price += ` | ${t}`; prev.benefit += ` | ${t}`; continue; }
      seen.add(key);
      out.push({ key, model: name, price: t, benefit: t });
    }
  }
  return out.map(({ key, ...r }) => r);
  return out;
}
