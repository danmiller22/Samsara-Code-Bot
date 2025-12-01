// Telegram webhook handler for Vercel + Samsara
// Node 18+ (Vercel) with global fetch

import fetch from 'node-fetch';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SAMSARA_API_KEY = process.env.SAMSARA_API_KEY;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const SAMSARA_BASE_URL = 'https://api.samsara.com';

/**
 * Helper: send message back to Telegram
 */
async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) {
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
 * Find vehicle in Samsara by user text (truck number)
 * Checks: name, licensePlate, any externalIds value (exact match)
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
 * Get active fault codes for a specific vehicle
 * Uses legacy /v1/fleet/maintenance/list and filters by vehicle.id
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

  // Heavy-duty J1939 data
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

  // Light-duty passenger data
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
 * Format faults to human-readable string
 */
function formatFaultsMessage(truckLabel, vehicle, faultsInfo) {
  const headerLines = [];
  headerLines.push(`*Трак:* ${truckLabel}`);
  if (vehicle.vin) headerLines.push(`*VIN:* ${vehicle.vin}`);
  if (vehicle.licensePlate) headerLines.push(`*Номер:* ${vehicle.licensePlate}`);

  const lines = [headerLines.join('\n')];

  // Check engine
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(200).json({ ok: true, message: 'Bot is running.' });
    return;
  }

  try {
    const update = req.body;

    const message = update.message || update.edited_message;
    if (!message || !message.text) {
      res.status(200).json({ ok: true });
      return;
    }

    const chatId = message.chat.id;
    const text = String(message.text || '').trim();

    if (!text) {
      await sendTelegramMessage(chatId, 'Отправь номер трака одной строкой.');
      res.status(200).json({ ok: true });
      return;
    }

    // Basic command
    if (text === '/start') {
      await sendTelegramMessage(
        chatId,
        'Отправь номер трака (как в Samsara), а я покажу его активные ошибки.'
      );
      res.status(200).json({ ok: true });
      return;
    }

    const truckQuery = text;

    await sendTelegramMessage(chatId, `Ищу трак \`${truckQuery}\` в Samsara...`);

    const vehicle = await findVehicleByQuery(truckQuery);
    if (!vehicle) {
      await sendTelegramMessage(chatId, `Трак \`${truckQuery}\` не найден в Samsara.`);
      res.status(200).json({ ok: true });
      return;
    }

    const faultsInfo = await getVehicleFaults(vehicle.id);
    const msg = formatFaultsMessage(truckQuery, vehicle, faultsInfo);
    await sendTelegramMessage(chatId, msg);

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Handler error', err);
    try {
      if (req.body && req.body.message && req.body.message.chat) {
        await sendTelegramMessage(
          req.body.message.chat.id,
          'Произошла ошибка при запросе к Samsara. Сообщи администратору.'
        );
      }
    } catch (e) {
      console.error('Error sending failure message', e);
    }
    res.status(200).json({ ok: true });
  }
}
