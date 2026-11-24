import {test} from 'node:test';
import assert from 'node:assert/strict';
import {labelledOffers, reconcileOffers, explicitPrices, atomOffers} from './offers.mjs';
import {healthVerdict, kongetVerdict, HEALTH, KONGET} from './checks.mjs';

test('ESTEO читает строки таблицы по заголовкам, при разной длине колонок требует проверки', () => {
  const site = {brand:'ESTEO',site:'sales-uspehauto-esteo.ru'};
  const table = 'Модель\nESTEO V27\nESTEO MX\nЦена от\nот 4 990 000 руб\n3\nот 3 120 000 руб\n3\nОбщая выгода до\nВыгода до 930 000 руб\n2\nДо 600 000 руб\n2';
  assert.deepEqual(labelledOffers(table,site), [
    {model:'V27',price:4990000,max_benefit:930000},{model:'MX',price:3120000,max_benefit:600000}
  ]);
  assert.deepEqual(labelledOffers(table.replace('от 3 120 000 руб',''),site),[]);
});

test('карточки разных доменов TANK не смешиваются, выгода не превращается в цену', () => {
  const site = {site:'lp.tank-borishof.ru',brand:'TANK'};
  const result = reconcileOffers([{model:'500',price:850000,max_benefit:'-'}],
    labelledOffers('TANK 500\nВЫГОДА ДО\n850 000 ₽\nУзнать цену по акции',site), site);
  assert.equal(result[0].price,'-');
  assert.equal(result[0].max_benefit,850000);
  assert.deepEqual(explicitPrices('Выгода до 850 000 ₽\nот 300 000 ₽/мес\nот 6 499 000 ₽'),[6499000]);
});

test('имя LADA берётся из собственной карточки, подпись следующей формы игнорируется', () => {
  assert.deepEqual(atomOffers([['XCITE X-CROSS 8','от 2 809 000 ₽','Выберите свою lada largus'],
    ['LADA LARGUS','от 1 277 600 ₽']], {brand:'LADA'}).map(r=>[r.model,r.price]),
    [['XCITE X-CROSS 8',2809000],['Largus',1277600]]);
});

test('заглушки, смена поддомена и условная установка в JavaScript', () => {
  for (const text of ['Сайт на реконструкции','Сайт создан, но еще не запущен в работу']) {
    assert.equal(healthVerdict({status:200,title:text,text}).health,HEALTH.stub);
  }
  assert.equal(healthVerdict({status:200,title:'Автосервис',text:'Каталог услуг '.repeat(15),site:'kia.example.ru',finalUrl:'https://podolsk.kia.example.ru/'}).reason,'Перенаправляет на podolsk.kia.example.ru');
  assert.equal(kongetVerdict({bundles:'"//app.konget.ru/inject?token=example01"'}).konget,KONGET.ok);
});

test('сохраняет меньшую цену подтверждённой страницы модели и отбрасывает случайную сумму главной', () => {
  const site = {site: 'dealer.example', brand: 'Geely'};
  const offer = {model: 'Atlas', price: 3000000, max_benefit: 150000};
  const card = {model: 'Atlas', price: 2200000, max_benefit: 500000};
  const [home] = reconcileOffers([card], [offer], site);
  assert.equal(home.price, 3000000);
  assert.equal(home.max_benefit, 150000);
  const [detail] = reconcileOffers([{...card, modelDetail: true}], [offer], site);
  assert.equal(detail.price, 2200000);
  assert.equal(detail.max_benefit, 500000);
  assert.equal('modelDetail' in detail, false);
});

test('видимое предложение официального дилера с реквизитами открывается без title', () => {
  const text = 'GEELY от официального дилера. Спеццена на автомобили. Модельный ряд и предложения. ИНН 5905000000.';
  assert.equal(healthVerdict({status: 200, text}).health, HEALTH.ok);
});

test('сбой загрузки скрипта не доказывает отсутствие Конгет', () => {
  assert.equal(kongetVerdict({scriptsUnavailable: true}).konget, KONGET.manual);
  assert.equal(kongetVerdict({scriptsUnavailable: true, requests: ['https://app.konget.ru/inject?token=abc123']}).konget, KONGET.ok);
});

test('общая осенняя выгода не подменяет подписанную выгоду Torres', () => {
  const fact = labelledOffers('Действует осенняя выгода до 1 600 000 ₽\nВыгода на KGM Torres до 950 000 ₽*', {brand:'KGM'});
  assert.deepEqual(fact, [{model:'TORRES', price:'-', max_benefit:950000}]);
});

test('предложения ТЕНЕТ и CHERY с кириллическими названиями не дублируются', () => {
  const site = {site:'chery-spb-pulkovo.ru',brand:'Chery'};
  const text = 'ТЕНЕТ T4L\nВыгода до 450 000 ₽\nCHERY АРРИЗО 8\nВыгода до 500 000 ₽';
  const found = reconcileOffers([{model:'ТЕНЕТ T4L', price:'-', max_benefit:200000}], labelledOffers(text, site), site);
  assert.deepEqual(found.map(m=>[m.model,m.max_benefit]), [['T4L',450000],['Arrizo 8',500000]]);
});

test('начало следующего каталога завершает предложение S09', () => {
  const text = 'S09\nТехнологичный кроссовер\nот 3 899 000 ₽?\nУзнать больше\nМодельный ряд\nот 2 589 000 ₽?';
  assert.equal(labelledOffers(text, {brand:'SOUEAST'})[0].price, 3899000);
});

test('после переключателей моделей видна цена первой открытой вкладки', () => {
  const text = 'S09\nКроссовер\nот 3 899 000 ₽\nУзнать больше\nМодельный ряд\nS06\nS07\nS09\nот 2 589 000 ₽';
  assert.equal(labelledOffers(text,{brand:'SOUEAST'}).find(m => m.model==='S09').price,3899000);
});
