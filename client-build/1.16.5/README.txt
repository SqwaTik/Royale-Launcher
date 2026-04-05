Royale Master 1.16.5

Что делает пакет:
- хранит отдельный клиентский инстанс в корне папки версии
- держит общие runtime-данные отдельно в папках versions, libraries, assets и jre
- запускается через Royale Launcher или профиль Minecraft Launcher
- не копирует моды в общий %APPDATA%\.minecraft\mods

Основной запуск идет как отдельный модифицированный Minecraft-клиент
с собственной структурой инстанса и общими runtime-папками.
