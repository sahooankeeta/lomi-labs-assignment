#!/bin/sh
# Runs at container start (nginx image runs /docker-entrypoint.d/*.sh).
# Logs where the UI is served and whether the api behind /api is reachable.
echo "web: serving UI on port 80 (on your machine: ${PUBLIC_URL:-http://localhost:8080})"
echo "web: proxying /api -> http://api:3000"
(
  for _ in $(seq 1 30); do
    if wget -q -O /dev/null -T 2 http://api:3000/health 2>/dev/null; then
      echo "web: api reachable at http://api:3000 (health ok)"
      exit 0
    fi
    sleep 1
  done
  echo "web: api NOT reachable at http://api:3000 after 30s"
) &
