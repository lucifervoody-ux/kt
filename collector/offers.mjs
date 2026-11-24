// Подписи моделей и сумм из опубликованного каталога. Справочник помогает распознать
// заголовок, но сам по себе не является основанием добавлять модель или цену.
import { MIN_PRICE, MAX_PRICE, parseRubles, cleanModel, mergeModels } from './lib.mjs';

const namesByBrand = {
  'москвич': 'М70|М90|3|3е|6|8',
  'haval': 'H3|H5|H7|H9|Jolion|M6|F7|F7x|Dargo|Dargo X|POER|POER KING KONG',
  'tank': '300|400|500|700|WEY 07|WEY 80|WEY 80 Лаундж|WEY V9X',
  'солярис': 'HC|HS|KRS|KRX', 'solaris': 'HC|HS|KRS|KRX',
  'belgee': 'Новый X50|X50+|X50|X70|S50',
  'лада': 'Granta|Iskra|Vesta|Aura|Largus|Niva Legend|Niva Travel|XCITE X-CROSS 8|SKM M7',
  'chery': 'Tiggo 4|Tiggo 4 Pro|Tiggo 7L|Tiggo 7 Pro|Tiggo 7 Pro Max|Tiggo 8 Pro Max|Tiggo 7 Pro Plug-in Hybrid|Tiggo 9|Arrizo 8',
  'tenet': 'T4|T4L|T7|T8|T9|A8|L4|L6',
  'jetour': 'T1|T1 Гибрид|T2|Dashing|Dashing AWD|X50|X70|X70+|X90+',
  'geely': 'Новый Coolray|Coolray|Cityray|Atlas|Atlas Pro|Monjaro|EX5|EX5 Гибрид|EX5 EM-i|Preface|Okavango|Emgrand',
  'gac': 'GS3|GS4|GS8|GS8 Traveller|AION V|HYPTEC HT|M8|S7|S9|Empow',
  'changan': 'CS35 MAX|CS35PLUS|CS75PLUS|CS75PLUS NEW|CS75PLUS NEW AWD|CS75 PRO|CS95|CS95NEW|UNI-S|UNI-S 4x4|UNI-V|UNI-V 2.0|UNI-T|UNI-K|UNI-K iDD|UNI-Z|UNI-L|ALSVIN|EADO PLUS|HUNTERplus|Lamore|Deepal S07|Deepal S09|Deepal G318',
  'jac': 'J7|T8 PRO|T9|RF8|JS3|JS4|JS6',
  'jaecoo': 'J6|J7|J8|JELAND J6|JELAND J7',
  'omoda': 'C5|C5 NEW|C7', 'exeed': 'VX|RX|TXL|LX|EXLANTIX ET|EXLANTIX ET8|EXLANTIX ES',
  'esteo': 'MX|V27|EXLANTIX ET|EXLANTIX ET8|EXLANTIX ES|EXEED RX',
  'soueast': 'S06|S07|S09', 'kgm': 'TIVOLI|KORANDO|TORRES|REXTON',
  'уаз': 'Патриот|Пикап|Хантер|Профи|Буханка',
};
namesByBrand.lada = namesByBrand['лада'];
const extraBrands = {
  'cherypulkovo.ru': ['tenet','chery'], 'chery-spb-pulkovo.ru': ['tenet','chery'], 'amk-chery.ru': ['tenet'],
  'omoda-jaecoo-42.ru': ['omoda', 'jaecoo'], 'sales-uspehauto-esteo.ru': ['esteo'],
};
const normal = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
const key = s => normal(s).replace(/^тенет\s+/,'tenet ').replace(/тигго/g,'tiggo').replace(/арризо/g,'arrizo').replace(/т(?=\d)/g, 't').replace(/с(?=\d)/g, 'c').replace(/а(?=\d)/g, 'a').replace(/(?<=[a-z0-9])\s+(?=[a-z0-9])/g, '');
function labels(site, names) {
  const map = new Map();
  const brand = normal(site.brand);
  const brands = [...new Set([brand, brand.split(/[ /]/)[0], ...(extraBrands[normal(site.site)] || [])])];
  for (const b of brands) {
    for (const name of (namesByBrand[b] || '').split('|').filter(Boolean)) {
      map.set(key(name), name);
      map.set(key(b + ' ' + name), name);
    }
  }
  for (const raw of names || []) {
    const name = cleanModel(raw, site.brand);
    const bare = name.replace(/^нов(?:ый|ая)\s+/i, '');
    if (name && !map.has(key(raw))) map.set(key(raw), map.get(key(name)) || map.get(key(bare)) || name);
    if (name && !map.has(key(name))) map.set(key(name), name);
  }
  for (const [from, to] of [['тигго','Tiggo'],['арризо','Arrizo'],['тенет','TENET']]) {
    for (const [k, name] of [...map]) if (k.startsWith(to.toLowerCase())) map.set(k.replace(to.toLowerCase(), from), name);
  }
  return map;
}
const money = '(\\d{1,3}(?:[ ,.]\\d{3}){1,2}|\\d{5,8})\\s*(?:₽|руб(?:лей|лям|ля|ль)?\\.?|р\\.)';
const price = new RegExp('^(?:цена\\s*(?:от)?|стоимость\\s*(?:от)?|от)\\s*[:—-]?\\s*(?:от\\s*)?' + money + '(?!\\s*(?:/|в)\\s*мес)', 'i');
const benefit = new RegExp('^(?:максимальная |общая |прямая |легкий обмен с )?(?:выгода|выгодой|преимущество|скидка)(?:\\s+(?:по|при|в|за)\\s+(?:трейд-ин|обмене|покупке|кредиту))?\\s*[:—-]?\\s*(?:до\\s*)?' + money, 'i');
const bareAmount = new RegExp('^' + money + '\\s*[*¹²³]*$', 'i');
const amount = (m) => m ? parseRubles(m[1])[0] : undefined;
const validPrice = n => n >= MIN_PRICE && n <= MAX_PRICE;
const excluded = /лизинг|маркетплейс|плат[её]ж|первоначальн|(?:\/|в)\s*мес/i;

function matrix(lines, map) {
  const start = lines.findIndex(x => /^модель$/i.test(x));
  if (start < 0) return [];
  const priceAt = lines.findIndex((x,i) => i > start && /^цена от$/i.test(x));
  if (priceAt <= start + 1) return [];
  const models = lines.slice(start+1, priceAt).map(x => map.get(key(x)));
  if (!models.length || models.some(x => !x) || new Set(models).size !== models.length) return [];
  function column(index) {
    const values = [];
    if (index < 0) return values;
    for (const line of lines.slice(index+1)) {
      if (/^[1-9]$/.test(line)) continue; // сноска в отдельном элементе
      const value = amount(line.replace(/^(?:выгода\s*)?(?:от|до)\s*/i,'').match(bareAmount));
      if (!value) break;
      values.push(value);
    }
    return values.length === models.length ? values : [];
  }
  const prices = column(priceAt);
  const benefits = column(lines.findIndex((x,i) => i > priceAt && /^общая выгода до$/i.test(x)));
  if (prices.length !== models.length || !prices.every(validPrice)) return [];
  return models.map((model,i) => ({model, price:prices[i], max_benefit:benefits[i] || '-'}));
}

export function labelledOffers(text, site, names = []) {
  const map = labels(site,names);
  const host = normal(site.site);
  // Preserve table boundaries before joining split currency and price labels.
  const fields = String(text || '').split(/\n+/).map(line => line.replace(/\s+/g,' ').trim()).filter(Boolean);
  const table = matrix(fields,map);
  if (table.length) return table;
  if (host === 'sales-uspehauto-esteo.ru') return [];

  const joined = String(text || '').replace(/(\d)\s*\n\s*(₽|руб\.?|р\.)(?=\s|\*|$)/gi, '$1 $2')
    .replace(/(выгода|преимущество|до|от|цена от:)\s*\n\s*(?=(?:до\s+|от\s+)?\d)/gi, '$1 ')
    .replace(/\b(?:CHERY|TENET|GAC|GEELY|TANK|BELGEE|OMODA|JAECOO)\n(?=[A-Za-zА-Яа-я]+\d)/g, match => match.trim()+' ');
  const lines = joined.split(/\n+/).map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean);

  const rows = [];
  const candidates = lines.map(line => {
    const parts = line.split(/\s+(?=(?:цена|стоимость|от|выгода|преимущество)\s+\d)/i);
    const label = parts[0].replace(/^(?:тенет|chery)\s+/i,'').replace(/^(?:новинка\s+|обновленный\s+|автомобиль\s+)/i,'').replace(/\s*\/\s*проверен временем.*$/i,'');
    const model = map.get(key(parts[0])) || map.get(key(label.replace(/^chery\s+/i,''))) || map.get(key(label)) || map.get(key(label.replace(/^новый\s+(?!x50$)/i,'')));
    return {model, inline: parts.slice(1).join(' ')};
  });
  for (let i=0; i<lines.length; i++) {
    const {model,inline} = candidates[i];
    if (!model) continue;
    // Вкладки каталога идут подряд. Цена после них относится к открытой вкладке.
    if (candidates[i-1]?.model && candidates[i-2]?.model && !inline) continue;
    const facts = inline ? [inline] : [];
    const reverse = ['tank-dynamica.ru','chery-center-spb.ru','belgee-cartelauto42.ru'].includes(host);
    if (reverse) {
      const prior = lines.slice(Math.max(0,i-4),i).join(' ');
      const b = prior.match(/(?:выгода\s*до|выгода)\s*([\d ,]+)\s*(?:₽|руб)\s*[*]*$/i);
      const p = prior.match(/(?:спеццена от|цена от:\s*от)\s+([\d ,]+)\s*₽[*]*$/i);
      const beforePrice = prior.match(/до ([\d ,]+)\s*₽[*]*\s+максимальная выгода\s+цена от/i);
      if (b || beforePrice) facts.push('Выгода до '+(b || beforePrice)[1]+' ₽');
      if (p) facts.push('от '+p[1]+' ₽');
    }
    for (let j=i+1; j<lines.length && j<=i+5 && !reverse && !candidates[j].model; j++) {
      if (/ПСК|модельный ряд|узнать больше|узнать подробности|подробнее о модели|кредит от|записаться|получить предложение|заказать звонок|отправить|консультация|юридическ/i.test(lines[j])) break;
      facts.push(lines[j]);
    }
    let min = Infinity, max = 0;
    for (let j=0;j<facts.length;j++) {
      const line = facts[j];
      const next = facts[j+1] || '';
      if (excluded.test(line)) continue;
      const phrase = /^(?:максимальная выгода|выгода|выгода до|цена от|от|до)$/i.test(line) ? line+' '+next : line;
      const p = amount(phrase.match(price));
      const b = amount(phrase.match(benefit));
      if (validPrice(p)) min=Math.min(min,p);
      if (b && !/при покупке .+|на модель .+/i.test(next)) max=Math.max(max,b);
    }
    rows.push({model,price:Number.isFinite(min)?min:'-',max_benefit:max||'-'});
  }
  // Предложение с явно названной моделью принадлежит ей даже вне каталога.
  for (const line of lines) {
    const match = line.match(/^выгода на (.+?) до (.+)$/i);
    const model = match && map.get(key(match[1]));
    const value = model && amount(match[2].match(bareAmount));
    if (value) rows.push({model, price: '-', max_benefit: value});
  }
  return mergeModels(rows);
}

export function explicitPrices(text) {
  const out = [];
  for (const part of String(text || '').split(/[|\n]/)) {
    const line = part.trim().replace(/\s+/g, ' ');
    if (excluded.test(line) || /выгод|скидк|преимуществ|кредит|взнос/i.test(line)) continue;
    const value = amount(line.match(price));
    if (validPrice(value)) out.push(value);
  }
  return out;
}

export function reconcileOffers(rows, labelled, site) {
  const brand = normal(site.brand);
  const lookup = labels(site, site.profile?.modelNames);
  const observed = new Map(labelled.map(r => [key(r.model), r]));
  const host = normal(site.site).replace(/^www\./,'');
  const anchoredOnly = ['sales-uspehauto-esteo.ru','lp.tank-borishof.ru','uaz-avtomarket.ru','uaz-agas.ru','amk-sam.ru'].includes(host);
  const kept = [];
  for (const {modelDetail, ...row} of rows) {
    const name = cleanModel(row.model,site.brand).replace(/^автомобиль\s+/i,'').replace(/\s+в Петрозаводске$/i,'').replace(/\s+[—–]\s+энергия без границ$/i,'');
    if (!name || anchoredOnly || key(name) === key(brand) || (host === 'demidich.ru' && /^(haval|tenet(?: plus)?|changan(?: uni)?|jac|sollers)$/i.test(name))) continue;
    let model = lookup.get(key(name)) || name;
    const bare = model.replace(/^нов(?:ая|ый)\s+/i,'');
    if (observed.has(key(bare))) model = observed.get(key(bare)).model;
    const fact = observed.get(key(model));
    // Полный текст карточки и числа из чужого блока не могут опровергать подписанную цену.
    const confirmedPrice = validPrice(fact?.price);
    const useDetail = modelDetail && validPrice(row.price);
    const price = confirmedPrice && !useDetail ? fact.price : row.price;
    const maxBenefit = !modelDetail && Number.isFinite(fact?.max_benefit) ? fact.max_benefit : row.max_benefit;
    kept.push({...row, model, price, max_benefit: maxBenefit});
  }
  return mergeModels([...kept, ...labelled.map(row => ({...row, source_url: /^https?:/.test(site.site) ? site.site : 'https://'+site.site}))]);
}

export function atomOffers(cards, site) {
  const lookup = labels(site, site.profile?.modelNames);
  return mergeModels(cards.flatMap(atoms => {
    // A Tilda artboard may hold either a single offer or the entire navigation.
    // Only an unambiguous model within this artboard owns its monetary fields.
    const fields = atoms.map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const models = new Set(fields.map(line => lookup.get(key(line))).filter(Boolean));
    if (models.size !== 1) return [];
    const [model] = models;
    const prices = fields.flatMap(explicitPrices);
    const benefits = fields.filter(line => !excluded.test(line)).map(line => amount(line.match(benefit))).filter(Boolean);
    if (!prices.length && !benefits.length) return [];
    return [{model, price: prices.length ? Math.min(...prices) : '-', max_benefit: benefits.length ? Math.max(...benefits) : '-'}];
  }));
}
