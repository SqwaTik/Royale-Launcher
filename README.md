# Royale Launcher

<p align="center">
  <img src="docs/assets/launcher-crest.png" alt="Royale Launcher" width="132">
</p>

<p align="center">
  Лаунчер для <strong>модифицированного Minecraft-клиента Royale Master</strong>.
  Он скачивает готовую сборку через GitHub Releases, обновляет файлы клиента в выбранной папке и запускает его из одного окна.
</p>

<p align="center">
  <a href="https://github.com/SqwaTik/Royale-Launcher/releases/latest">Последний релиз</a>
  ·
  <a href="https://github.com/SqwaTik/Royale-Launcher/releases/latest/download/RoyaleLauncherSetup.exe">Установщик</a>
  ·
  <a href="https://github.com/SqwaTik/Royale-Launcher/releases/latest/download/RoyaleLauncherPortable.exe">Portable</a>
  ·
  <a href="https://github.com/SqwaTik/Royale-Launcher/releases/latest/download/1.21.11.zip">Клиент 1.21.11</a>
</p>

## Скриншоты

| Главная | Настройки |
| --- | --- |
| ![Главный экран](docs/assets/preview-home.png) | ![Экран настроек](docs/assets/preview-settings.png) |

## Скачать

- Последний релиз: [github.com/SqwaTik/Royale-Launcher/releases/latest](https://github.com/SqwaTik/Royale-Launcher/releases/latest)
- Установщик: [RoyaleLauncherSetup.exe](https://github.com/SqwaTik/Royale-Launcher/releases/latest/download/RoyaleLauncherSetup.exe)
- Портативная версия: [RoyaleLauncherPortable.exe](https://github.com/SqwaTik/Royale-Launcher/releases/latest/download/RoyaleLauncherPortable.exe)
- Текущий пакет клиента: [1.21.11.zip](https://github.com/SqwaTik/Royale-Launcher/releases/latest/download/1.21.11.zip)

## Что умеет лаунчер

- Показывает фиксированный список версий, который задает владелец проекта, а не пользователь.
- Использует одну главную кнопку: `Скачать`, если версия еще не установлена, и `Запустить`, если она уже есть.
- По умолчанию ставит клиент в `C:\Royale\<версия>` и может обновлять уже существующую папку поверх старых файлов.
- Сохраняет изменения в настройках автоматически после каждого редактирования.
- Проверяет GitHub Releases и показывает баннер обновления, когда выходит новая версия лаунчера.
- Поддерживает два формата распространения: `Setup` и `Portable`.

## Поддерживаемые версии

- `1.21.11`
- `26.1`
- `1.21.4`
- `1.16.5`
- `1.12.2`

## Как устроены релизы

Лаунчер берет список версий из файла [`electron/version-catalog.json`](electron/version-catalog.json).

- В интерфейсе отображаются только те версии, которые есть в каталоге.
- Каждая версия может ссылаться на отдельный asset в GitHub Release.
- Для `1.21.11` уже подключен пакет из `releases/latest`, поэтому ссылка не привязана к одному старому тегу.
- Обновления самого лаунчера публикуются в этом же репозитории и подхватываются верхним баннером обновления.

## Структура проекта

- [`src/App.jsx`](src/App.jsx) - интерфейс лаунчера и логика страниц
- [`src/styles.css`](src/styles.css) - стили, компоновка и визуальная часть
- [`electron/main.cjs`](electron/main.cjs) - установка, запуск, состояние версий и проверка обновлений
- [`electron/preload.cjs`](electron/preload.cjs) - безопасный мост API между Electron и интерфейсом
- [`electron/version-catalog.json`](electron/version-catalog.json) - каталог версий, который редактирует владелец проекта
- [`electron/launcher-config.json`](electron/launcher-config.json) - источник обновлений лаунчера
- [`client-build/1.21.11/launch.bat`](client-build/1.21.11/launch.bat) - вспомогательный скрипт запуска клиента

## Локальный запуск

```bash
npm install
npm run dev
```

## Сборка Windows-версий

```bash
npm run dist:win:setup
npm run dist:win:portable
```

Готовые сборки появляются в папке `dist-app/`.

## Чеклист публикации

1. Обновить код лаунчера или связанные assets.
2. При необходимости изменить [`electron/version-catalog.json`](electron/version-catalog.json).
3. Собрать новые `.exe`.
4. Создать или обновить GitHub Release.
5. Загрузить `RoyaleLauncherSetup.exe`, `RoyaleLauncherPortable.exe` и нужные клиентские пакеты.

## Статус

Этот репозиторий является основной точкой распространения Royale Launcher и его клиентских сборок.
