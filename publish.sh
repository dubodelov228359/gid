#!/bin/sh
# Выпустить обновление: новая версия сайта -> приложение на телефоне подхватит её при следующем запуске.
set -e
cd "$(dirname "$0")"
date -u +%Y.%m.%d-%H%M > docs/version.json
# Новая версия кэша для веб-версии (iPhone), чтобы Safari тоже взял свежие файлы.
sed -i "s/const VERSION = 'tg-app-[^']*'/const VERSION = 'tg-app-$(cat docs/version.json)'/" docs/sw.js
echo "Версия: $(cat docs/version.json)"
