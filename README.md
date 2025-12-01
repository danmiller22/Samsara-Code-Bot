# Samsara Telegram Bot

Бот для Telegram, который по номеру трака показывает активные ошибки из Samsara.

## Что он делает

1. Принимает сообщение в Telegram с номером трака (например `1234` или `TRK-1234`).
2. Ищет соответствующий трак в Samsara по:
   - `name`
   - `licensePlate`
   - значениям в `externalIds`
3. Находит активные ошибки по этому траку через Samsara API.
4. Отвечает в чат с кратким списком активных ошибок либо пишет, что ошибок нет.

## Переменные окружения

На Vercel нужно задать:

- `TELEGRAM_BOT_TOKEN` — токен бота от @BotFather.
- `SAMSARA_API_KEY` — API ключ Samsara (Bearer-токен).

## Деплой на Vercel (кратко)

1. Залить этот проект в GitHub.
2. В Vercel: **New Project** → импортировать репозиторий.
3. В настройках проекта Vercel задать переменные окружения:
   - `TELEGRAM_BOT_TOKEN`
   - `SAMSARA_API_KEY`
4. Задеплоить. URL webhook будет примерно:
   `https://<project-name>.vercel.app/api/telegram-webhook`
5. Настроить webhook для Telegram:

   ```bash
   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<project-name>.vercel.app/api/telegram-webhook"
   ```

## Использование

- Написать боту номер трака.
- Бот вернет список активных ошибок для этого трака (если они есть).
