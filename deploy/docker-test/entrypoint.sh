#!/bin/sh
# First run seeds the config volume with a llama.cpp provider; later runs keep
# whatever the user changed in the web settings.
set -eu

mkdir -p /config/config /workspace
if [ ! -f /config/config/provider.json ]; then
  cp /app/deploy/docker-test/seed/provider.json /config/config/provider.json
fi
if [ ! -f /config/config/core.json ]; then
  cp /app/deploy/docker-test/seed/core.json /config/config/core.json
fi
if [ ! -f /config/config/security.json ]; then
  cp /app/deploy/docker-test/seed/security.json /config/config/security.json
fi
# Песочница: агент читает AGENTS.md из рабочей директории. Не затираем файл,
# если пользователь уже положил свой.
if [ ! -f /workspace/AGENTS.md ]; then
  cp /app/deploy/docker-test/seed/AGENTS.md /workspace/AGENTS.md
fi

exec bun /app/src/cli/main.ts web --host 0.0.0.0 --port 7333 --no-open
