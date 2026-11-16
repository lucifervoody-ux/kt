// Проверка связи с ИИ: один запрос, печатает адрес сервиса, модели и точный ответ (ключ не печатается).
import { baseUrl, askAi } from './ai.mjs';

const env = process.env;
console.log('Адрес сервиса:', baseUrl(env));
console.log('Модель (AI_MODEL):', env.AI_MODEL || '(авто)');
console.log('Ключ задан:', env.AI_API_KEY ? `да, начало ${String(env.AI_API_KEY).slice(0, 6)}…` : 'НЕТ');
try {
  const r = await askAi({ brand: 'Test', site: 'https://example.ru', pageText: 'Test Rio от 1 500 000 ₽, выгода до 300 000 ₽' });
  console.log('Ответ ИИ:', JSON.stringify(r));
} catch (e) {
  console.log('Ошибка:', e.message);
  process.exitCode = 1;
}
