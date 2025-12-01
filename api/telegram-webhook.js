// api/telegram-webhook.js
// Samsara + Gemini, CommonJS для Vercel. ИИ даёт советы "что делать сейчас".

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SAMSARA_API_KEY = process.env.SAMSARA_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const TELEGRAM_API = TELEGRAM_BOT_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`
  : null;

const SAMSARA_BASE_URL = 'https://api.samsara.com';
const GEMINI_MODEL = 'models/gemini-1.5-flash';

// --- Telegram ---

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

// --- Samsara ---

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

// --- Gemini (ИИ советы) ---

function buildFaultsPrompt(truckLabel, vehicle, faultsInfo) {
  if (!faultsInfo.faults || faultsInfo.faults.length === 0) {
    return null;
  }

  const lines = [];
  lines.push('Ты помогаешь механику/диспетчеру по грузовым тракам.');
  lines.push('У тебя есть список кодов ошибок двигателя/шасси из телематики (Samsara, J1939, OBD).');
  lines.push('Для КАЖДОЙ ошибки нужно коротко и по-русски объяснить:');
  lines.push('- что это за узел или система;');
  lines.push('- что означает этот код;');
  lines.push('- что ПРЯМО СЕЙЧАС имеет смысл проверить (разъёмы, проводку, утечки, датчик и т.д.);');
  lines.push('- можно ли продолжать рейс или пора/нужно ехать в сервис, либо остановиться.');
  lines.push('');
  lines.push('Формат ответа:');
  lines.push('- по каждой ошибке отдельный пронумерованный пункт;');
  lines.push('- в каждом пункте 3–6 коротких строк:');
  lines.push('  - "Что это";');
  lines.push('  - "Что значит";');
  lines.push('  - "Что проверить";');
  lines.push('  - "Как поступить".');
  lines.push('');
  lines.push('ВАЖНО по Manufacturer Assignable SPN:');
  lines.push('- если в описании есть фраза "Manufacturer Assignable SPN", это внутренний код производителя;');
  lines.push('- не выдумывай точный смысл такого кода;');
  lines.push('- явно напиши, что это OEM-специфичный код и точная расшифровка возможна только в дилерской программе;');
  lines.push('- можно дать ОБЩИЕ рекомендации по проверке проводки/разъёмов/нагрузки и по тому, когда ехать в сервис.');
  lines.push('');
  lines.push(`Трак: ${truckLabel}`);
  if (vehicle.vin) lines.push(`VIN: ${vehicle.vin}`);
  if (vehicle.licensePlate) lines.push(`License plate: ${vehicle.licensePlate}`);
  lines.push('');
  lines.push('Список ошибок:');

  faultsInfo.faults.slice(0, 20).forEach((f, idx) => {
    const parts = [];
    if (f.code) parts.push(`code=${f.code}`);
    if (f.short) parts.push(`short="${f.short}"`);
    if (f.text) parts.push(`details="${f.text}"`);
    const line = parts.join(', ');
    lines.push(`${idx + 1}. ${line}`);
  });

  return lines.join('\n');
}

async function explainFaultsWithGemini(truckLabel, vehicle, faultsInfo) {
  if (!GEMINI_API_KEY) {
    return null;
  }
  const prompt = buildFaultsPrompt(truckLabel, vehicle, faultsInfo);
  if (!prompt) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(
    GEMINI_API_KEY
  )}`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ]
      })
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.error('Gemini error:', resp.status, body);
      return null;
    }

    const data = await resp.json();
    const candidates = data.candidates || [];
    if (!candidates.length) return null;
    const parts = (candidates[0].content && candidates[0].content.parts) || [];
    const textParts = parts
      .map(p => (typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean);
    const text = textParts.join('\n').trim();
    return text || null;
  } catch (e) {
    console.error('Gemini request failed', e);
    return null;
  }
}

// --- Формирование ответа ---

function formatFaultsMessage(truckLabel, vehicle, faultsInfo, aiExplanation) {
  const headerLines = [];
  headerLines.push(`*Трак:* ${truckLabel}`);
  if (vehicle.vin) headerLines.push(`*VIN:* ${vehicle.vin}`);
  if (vehicle.licensePlate) headerLines.push(`*Номер:* ${vehicle.licensePlate}`);

  const lines = [headerLines.join('\n')];

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

  lines.push('\n*Активные ошибки (сырые данные Samsara):*');
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

  if (aiExplanation) {
    lines.push('\n*Что делать сейчас:*');
    lines.push(aiExplanation);
  }

  return lines.join('\n');
}

// --- Основной хэндлер ---

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
        'Отправь номер трака (3–4 цифры). Я покажу активные ошибки из Samsara и дам советы, что делать сейчас.'
      );
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }

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
    const aiExplanation = await explainFaultsWithGemini(truckQuery, vehicle, faultsInfo);
    const msg = formatFaultsMessage(truckQuery, vehicle, faultsInfo, aiExplanation);
    await sendTelegramMessage(chatId, msg);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    console.error('Handler error', err);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  }
};
