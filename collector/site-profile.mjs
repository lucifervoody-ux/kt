// В браузере: цены из разметки автомобиля или из отмеченных для этого домена блоков.
// Каждая сумма должна относиться к одной конкретной модели на открытой странице.
export function profileRows({ brand, priceAnchors = [], modelNames = [] }) {
  const out = [];
  const canonical = (s) => String(s || '').trim().toLowerCase();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const types = [].concat(node['@type'] || []);
    const markedBrand = typeof node.brand === 'string' ? node.brand : node.brand?.name;
    const sameBrand = canonical(markedBrand) && canonical(markedBrand) === canonical(brand);
    if (types.some((t) => /^(Vehicle|Car|Product)$/i.test(t)) && (sameBrand || types.some((t) => /^(Vehicle|Car)$/i.test(t)) && !markedBrand)) {
      const model = (typeof node.model === 'string' ? node.model : node.model?.name) || (sameBrand && node.name);
      if (typeof model === 'string' && model.trim() && model.length < 60) {
        for (const offer of [].concat(node.offers || [])) {
          if (!offer || !/^RUB$/i.test(offer.priceCurrency) || /used|lease|rent/i.test([offer.itemCondition, offer.businessFunction].join(' '))) continue;
          const price = Number(String(offer.lowPrice ?? offer.price ?? '').replace(/\s+/g, ''));
          if (Number.isInteger(price) && price >= 300000 && price <= 30000000) out.push({ model, price: String(price), benefit: '' });
        }
      }
    }
    Object.values(node).forEach(visit);
  };
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(el.textContent)); } catch { /* Некорректная разметка этой страницы. */ }
  }
  const names = 'h1,h2,h3,h4,[class*="model-name"],[class*="model__name"],[class*="model-title"],[class*="__title"],[class*="__name"]';
  // Для лендинга без типовых классов: название и предложение должны быть в одном блоке.
  const aliases = new Map();
  for (const model of modelNames) {
    for (const name of [model, `${brand} ${model}`]) aliases.set(canonical(name), model);
  }
  const headings = new Map();
  if (aliases.size) {
    for (const node of document.querySelectorAll(`${names},[class*="model" i],strong`)) {
      const label = canonical(node.innerText || node.textContent).replace(/^нов(?:ый|ая)\s+/i, '');
      if (aliases.has(label)) headings.set(node, aliases.get(label));
    }
  }
  for (const [heading, model] of headings) {
    for (let box = heading.parentElement, i = 0; box && i < 6; box = box.parentElement, i += 1) {
      const text = (box.innerText || '').trim();
      if (box.tagName === 'BODY' || text.length > 1000) break;
      if ([...headings].some(([other, otherModel]) => otherModel !== model && box.contains(other))) break;
      const prices = [...text.matchAll(/(?:^|\n)\s*(?:цена\s*[:—-]?\s*)?(?:от\s*)?(\d[\d \u00a0\u202f.,]+\s*(?:₽|руб\.?))\s*[*¹²³]*\s*(?=\n|$)/gi)].map((m) => m[1]);
      const benefits = text.split(/\n/).filter((line) => /(?:выгода|скидка)\s*(?:до\s*)?\d[\d \u00a0\u202f.,]+\s*(?:₽|руб)/i.test(line));
      if (!prices.length && !benefits.length) continue;
      // Если годовые платежи или кредитные условия вынесены на соседнюю строку, цену не берём.
      const price = new Set(prices).size === 1 && !/в месяц|плат[её]ж|первоначальн|\/мес|лизинг|старая цена/i.test(text) ? prices[0] : '';
      if (price || benefits.length) out.push({ model, price, benefit: benefits.join(' | ') });
      break;
    }
  }
  for (const selector of priceAnchors) {
    for (const el of document.querySelectorAll(selector)) {
      const price = (el.innerText || el.textContent || '').trim();
      if (!/^(?:цена\s*[:—-]?\s*)?(?:от\s*)?\d[\d\s.,]*\s*(?:₽|руб\.?|рублей|рубля|р\.)(?:\s*[*¹²³]*)?$/i.test(price)) continue;
      for (let box = el.parentElement, i = 0; box && i < 5; box = box.parentElement, i += 1) {
        if (box.querySelectorAll(selector).length !== 1 || box.tagName === 'BODY') break;
        const candidates = new Set([...box.querySelectorAll(names)].map((n) => (n.innerText || n.textContent).trim())
          .filter((s) => s.length >= 2 && s.length <= 35 && !/[₽!?%\n]|цен|кредит|выгод|рубл|акци|предлож|подар|подробнее|комплект|плат[её]ж|автомобил|скидк|модельный|купить/i.test(s)));
        if (candidates.size === 1) { out.push({ model: [...candidates][0], price, benefit: '' }); break; }
        if (candidates.size > 1) break;
      }
    }
  }
  return out;
}

export function sameSite(address, home) {
  try {
    const url = new URL(address);
    const host = (u) => u.hostname.replace(/^www\./i, '');
    return /^https?:$/.test(url.protocol) && host(url) === host(new URL(home));
  } catch { return false; }
}

export function modelRoute(address, prefixes) {
  const path = new URL(address).pathname.replace(/\/$/, '');
  return prefixes.some((prefix) => {
    if (!path.startsWith(prefix)) return false;
    const slug = path.slice(prefix.length);
    return /^[\w-]+$/.test(slug) && !/used|stock|new-car|catalog|sale|finance|service|credit|available|^new$|^all$|probeg|in-stock|nalich|config|special|^\d{4,}$/i.test(slug);
  });
}
