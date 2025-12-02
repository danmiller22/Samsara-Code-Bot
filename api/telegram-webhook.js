// api/telegram-webhook.js
// Telegram бот: Samsara + Gemini. ИИ даёт конкретные советы "что делать сейчас".

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SAMSARA_API_KEY = process.env.SAMSARA_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MISTRAL_API_KEY  = process.env.MISTRAL_API_KEY;
const MISTRAL_MODEL    = process.env.MISTRAL_MODEL || 'mistral-small-latest';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL   = process.env.OPENROUTER_MODEL || 'cognitivecomputations/dolphin3.0-r1-mistral-24b:free';
const OPENROUTER_REF     = process.env.OPENROUTER_REF || 'https://github.com/danmiller22/Samsara-Code-Bot';
const OPENROUTER_TITLE   = process.env.OPENROUTER_TITLE || 'Samsara Code Bot';

const TELEGRAM_API = TELEGRAM_BOT_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`
  : null;

const SAMSARA_BASE_URL = 'https://api.samsara.com';
const GEMINI_MODEL = 'models/gemini-1.5-flash';

// ------------ Telegram helper ------------

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

// ------------ Samsara: поиск трака и ошибки ------------

async function findVehicleByQuery(query) {
  if (!SAMSARA_API_KEY) {
    throw new Error('SAMSARA_API_KEY is not set');
  }

  const url = `${SAMSARA_BASE_URL}/fleet/vehicles?limit=512`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${SAMSARA_API_KEY}`,
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
      Authorization: `Bearer ${SAMSARA_API_KEY}`,
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

  // J1939
  if (found.j1939) {
    if (found.j1939.checkEngineLight) {
      result.checkEngine = {
        type: 'j1939',
        data: found.j1939.checkEngineLight
      };
    }
    if (Array.isArray(found.j1939.diagnosticTroubleCodes)) {
      for (const code of found.j1939.diagnosticTrouCodes || found.j1939.diagnosticTroubleCodes) {
        // original code used diagnosticTroubleCodes; keep fallback for possible typo
      }
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

  // Passenger/light-duty
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

// ------------ Gemini: советы по ошибкам ------------

function buildFaultsPrompt(truckLabel, vehicle, faultsInfo) {
  if (!faultsInfo.faults || faultsInfo.faults.length === 0) return null;

  const lines = [];
  lines.push('Ты помогаешь механику/диспетчеру по грузовым тракам.');
  lines.push('ДАНО: список кодов ошибок двигателя/шасси из телематики (Samsara, J1939, OBD).');
  lines.push('');
  lines.push('ЗАДАЧА: для КАЖДОЙ ошибки дать очень практичный ответ по шаблону:');
  lines.push('1) "Что это:" кратко, какой узел/система.');
  lines.push('2) "Что значит:" что фиксирует блок управления.');
  lines.push('3) "Что проверить:" конкретный чек-лист (разъёмы, проводку, датчик, утечки и т.п.).');
  lines.push('4) "Как поступить:" можно ли продолжать рейс, когда ехать в сервис, надо ли останавливать грузовик.');
  lines.push('');
  lines.push('Требования:');
  lines.push('- Пиши по-русски.');
  lines.push('- Минимум теории, максимум конкретных действий.');
  lines.push('- К каждому пункту 1–2 коротких предложения, без воды.');
  lines.push('- Не придумывай несуществующих кодов, не меняй номера кодов.');
  lines.push('');
  lines.push('Особый случай Manufacturer Assignable SPN:');
  lines.push('- если в описании есть "Manufacturer Assignable SPN", это OEM-специфичный код;');
  lines.push('- напиши явно, что точное значение только в дилерской диагностике для этой марки;');
  lines.push('- всё равно дай общие шаги: что проверить и как поступить.');
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

async function getGeminiAdvice(truckLabel, vehicle, faultsInfo) {
  if (!GEMINI_API_KEY) return null;
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
    return text;
  } catch (e) {
    console.error('Gemini request failed', e);
    return null;
  }
}

// ------------ Бесплатные модели: Mistral и OpenRouter ------------

async function callMistral(prompt) {
  if (!MISTRAL_API_KEY) return null;
  try {
    const resp = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MISTRAL_API_KEY}`,
      },
      body: JSON.stringify({
        model: MISTRAL_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 512,
        temperature: 0.3,
      }),
    });
    if (!resp.ok) {
      console.error('Mistral error:', resp.status, await resp.text());
      return null;
    }
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch (err) {
    console.error('Mistral request failed', err);
    return null;
  }
}

async function callOpenRouter(prompt) {
  if (!OPENROUTER_API_KEY) return null;
  try {
    const url = 'https://openrouter.ai/api/v1/chat/completions';
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': OPENROUTER_REF,
        'X-Title': OPENROUTER_TITLE,
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 512,
        temperature: 0.5,
      }),
    });
    if (!resp.ok) {
      console.error('OpenRouter error:', resp.status, await resp.text());
      return null;
    }
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch (err) {
    console.error('OpenRouter request failed', err);
    return null;
  }
}

async function getFreeAIAdvice(truckLabel, vehicle, faultsInfo) {
  const prompt = buildFaultsPrompt(truckLabel, vehicle, faultsInfo);
  if (!prompt) return null;
  // Пытаемся сначала Mistral, затем OpenRouter
  if (MISTRAL_API_KEY) {
    const result = await callMistral(prompt);
    if (result) return result;
  }
  if (OPENROUTER_API_KEY) {
    const result = await callOpenRouter(prompt);
    if (result) return result;
  }
  return null;
}

async function getAiAdvice(truckLabel, vehicle, faultsInfo) {
  // при наличии ключа Gemini используем его в первую очередь
  if (GEMINI_API_KEY) {
    const geminiAdvice = await getGeminiAdvice(truckLabel, vehicle, faultsInfo);
    if (geminiAdvice) return geminiAdvice;
  }
  // иначе пытаемся бесплатные API
  return await getFreeAIAdvice(truckLabel, vehicle, faultsInfo);
}

// ------------ Формирование сообщения ------------

function formatFaultsMessage(truckLabel, vehicle, faultsInfo, aiAdvice) {
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

  if (aiAdvice) {
    lines.push('\n*Что делать сейчас:*');
    lines.push(aiAdvice);
  }

  return lines.join('\n');
}

// ------------ Основной handler для Vercel ------------

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
        'Отправь номер трака (3–4 цифры). Я покажу активные ошибки из Samsara и дам конкретные советы, что делать сейчас.'
      );
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // вытаскиваем 3–4-значный номер
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
    const aiAdvice = await getAiAdvice(truckQuery, vehicle, faultsInfo);
    const msg = formatFaultsMessage(truckQuery, vehicle, faultsInfo, aiAdvice);

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