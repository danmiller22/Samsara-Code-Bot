// api/telegram-webhook.js
// CommonJS-версия для Vercel (@vercel/node), без node-fetch

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SAMSARA_API_KEY = process.env.SAMSARA_API_KEY;

const TELEGRAM_API = TELEGRAM_BOT_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`
  : null;

const SAMSARA_BASE_URL = 'https://api.samsara.com';

/**
 * Помощник: отправка сообщения в Telegram
 */
async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_API) {
    console.error('TELEGRAM_BOT_TOKEN is not set');
    return;
  }
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown'
      })
    });
  } catch (err) {
    console.error('Error sending telegram message', err);
  }
}

/**
 * Прочитать тело запроса (JSON из Telegram)
 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * Поиск трака в Samsara по строке (номер 3–4 цифры, name, externalIds, номерной знак)
 */
async function findVehicleByQuery(query) {
  if (!SAMSARA_API_KEY) {
    throw new Error('SAMSARA_API_KEY is not set');
  }

  const url = `${SAMSARA_BASE_URL}/fleet/vehicles?limit=512`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${SAMSARA_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error('Samsara vehicles error:', resp.status, body);
    throw new Error(`Samsara vehicles request failed with status ${resp.status}`);
  }

  const json = await resp.json();
  const vehicles = json.data || [];

  const normalizedQuery = String(query).trim().toLowerCase();

  let bestMatch = null;

  for (const v of vehicles) {
    const name = (v.name || '').toLowerCase();
    const license = (v.licensePlate || '').toLowerCase();
    if (name === normalizedQuery || license === normalizedQuery) {
      bestMatch = v;
      break;
    }

    const externalIds = v.externalIds || {};
    for (const key of Object.keys(externalIds)) {
      const val = String(externalIds[key] || '').toLowerCase();
      if (val === normalizedQuery) {
        bestMatch = v;
        break;
      }
    }
    if (bestMatch) break;
  }

  return bestMatch;
}

/**
 * Получить активные ошибки для конкретного трака
 */
async function getVehicleFaults(vehicleId) {
  const url = `${SAMSARA_BASE_URL}/v1/fleet/maintenance/list`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${SAMSARA_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error('Samsara maintenance error:', resp.status, body);
    throw new Error(`Samsara maintenance request failed with status ${resp.status}`);
  }

  const json = await resp.json();
  const vehicles = json.vehicles || [];

  const found = vehicles.find(v => String(v.id) === String(vehicleId));
  if (!found) {
    return { faults: [], checkEngine: null };
  }

  const result = {
    faults: [],
    checkEngine: null
  };

  // Heavy-duty J1939
  if (found.j1939) {
    if (found.j1939.checkEngineLight) {
      result.checkEngine = {
        type: 'j1939',
        data: found.j1939.checkEngineLight
      };
    }
    if (Array.isArray(found.j1939.diagnosticTroubleCodes)) {
      for (const code of found.j1939.diagnosticTroubleCodes) {
        result.faults.push({
          source: 'j1939',
          code: code.spnId ?? code.txId ?? null,
          short: code.spnDescription || null,
          text: code.fmiText || null,
          occurrenceCount: code.occurrenceCount ?? null
        });
      }
    }
  }

  // Light-duty passenger
  if (found.passenger) {
    if (found.passenger.checkEngineLight) {
      result.checkEngine = {
        type: 'passenger',
        data: found.passenger.checkEngineLight
      };
    }
    if (Array.isArray(found.passenger.diagnosticTroubleCodes)) {
      for (const code of found.passenger.diagnosticTroubleCodes) {
        result.faults.push({
          source: 'passenger',
          code: code.dtcShortCode || null,
          short: code.dtcDescription || null,
          text: null,
          occurrenceCount: null
        });
      }
    }
  }

  return result;
}

/**
 * Форматируем текст ответа
 */
function formatFaultsMessage(truckLabel, vehicle, faultsInfo) {
  const headerLines = [];
  headerLines.push(`*Трак:* ${truckLabel}`);
  if (vehicle.vin) headerLines.push(`*VIN:* ${vehicle.vin}`);
  if (vehicle.licensePlate) headerLines.push(`*Номер:* ${vehicle.licensePlate}`);

  const lines = [headerLines.join('\n')];

  // Check Engine
  if (faultsInfo.checkEngine && faultsInfo.checkEngine.data) {
    const ce = faultsInfo.checkEngine.data;
    const flags = [];

    if (ce.warningIsOn) flags.push('Warning');
    if (ce.emissionsIsOn) flags.push('Emissions');
    if (ce.protectIsOn) flags.push('Protect');
    if (ce.stopIsOn) flags.push('Stop');
    if (ce.isOn) flags.push('Check Engine');

    if (flags.length > 0) {
      lines.push('\n*Check Engine:* ' + flags.join(', '));
    }
  }

  if (!faultsInfo.faults || faultsInfo.faults.length === 0) {
    lines.push('\nАктивных ошибок не найдено.');
    return lines.join('\n');
  }

  lines.push('\n*Активные ошибки:*');
  faultsInfo.faults.slice(0, 20).forEach((f, idx) => {
    const num = idx + 1;
    const parts = [];
    if (f.code) parts.push(`Код: \`${f.code}\``);
    if (f.short) parts.push(f.short);
    if (f.text) parts.push(f.text);
    if (f.occurrenceCount != null) parts.push(`(повторений: ${f.occurrenceCount})`);

    const line = parts.length > 0 ? parts.join(' — ') : 'Неизвестная ошибка';
    lines.push(`${num}. ${line}`);
  });

  return lines.join('\n');
}

/**
 * Основной обработчик Vercel
 */
module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, message: 'Bot is running.' }));
      return;
    }

    const rawBody = await readRequestBody(req);
    let update = {};
    try {
      update = rawBody ? JSON.parse(rawBody) : {};
    } catch (e) {
      console.error('Failed to parse JSON body', e);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const message = update.message || update.edited_message;
    if (!message || !message.text) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const chatId = message.chat.id;
    const text = String(message.text || '').trim();

    if (!text) {
      await sendTelegramMessage(chatId, 'Отправь номер трака одной строкой.');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (text === '/start') {
      await sendTelegramMessage(
        chatId,
        'Отправь номер трака (3–4 цифры), а я покажу его активные ошибки по данным Samsara.'
      );
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Вытаскиваем 3–4-значный номер трака из сообщения
    const match = text.match(/\b(\d{3,4})\b/);
    const truckQuery = match ? match[1] : text;

    await sendTelegramMessage(chatId, `Ищу трак \`${truckQuery}\` в Samsara...`);

    const vehicle = await findVehicleByQuery(truckQuery);
    if (!vehicle) {
      await sendTelegramMessage(chatId, `Трак \`${truckQuery}\` не найден в Samsara.`);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const faultsInfo = await getVehicleFaults(vehicle.id);
    const msg = formatFaultsMessage(truckQuery, vehicle, faultsInfo);
    await sendTelegramMessage(chatId, msg);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    console.error('Handler error', err);
    try {
      if (TELEGRAM_API && req && req.body && req.body.message && req.body.message.chat) {
        await sendTelegramMessage(
          req.body.message.chat.id,
          'Произошла ошибка при запросе к Samsara. Сообщи администратору.'
        );
      }
    } catch (e) {
      console.error('Error sending failure message', e);
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  }
};
