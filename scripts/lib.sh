# Shared helpers for the end-to-end scripts (verify-phase1.sh, chaos.sh). Source it from the repo
# root: `. scripts/lib.sh`. Needs bash, curl, node and docker compose (Git Bash on Windows works).
#
# Every helper talks to the running compose stack: the API over HTTP (API_URL, default
# http://localhost:3000) and the containers through `docker compose`.

API="${API_URL:-http://localhost:3000}"
FAILS=0
TMP=".verify-tmp"
mkdir -p "$TMP"

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILS=$((FAILS + 1)); }
check() { if [ "$1" = "ok" ]; then pass "$2"; else fail "$2 ($3)"; fi; }

# jget <dotted.path>: read JSON on stdin, print the value (empty if missing or invalid).
jget() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v==null?v:v[k];console.log(v==null?"":v)}catch{console.log("")}})' "$1"
}

# jlen <dotted.path>: like jget, but prints the length of the array there ("." = the root).
# Empty when it is not an array, so a broken body never reads as a count of 0.
jlen() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);if(process.argv[1]!==".")for(const k of process.argv[1].split("."))v=v==null?v:v[k];console.log(Array.isArray(v)?v.length:"")}catch{console.log("")}})' "$1"
}

# api_get <path>: print the body of GET $API<path>. Returns 1 on anything but 200 (and says so on
# stderr), so an assertion can never pass on an error body or a dead API.
api_get() {
  local code
  code=$(curl -s -o "$TMP/get.json" -w '%{http_code}' "$API$1")
  if [ "$code" != "200" ]; then
    echo "api_get $1: HTTP $code" >&2
    return 1
  fi
  cat "$TMP/get.json"
}

doc_status() { curl -s "$API/documents/$1" | jget status; }

# wait_status <id> <status> <seconds>: poll until the document's current version reaches the status.
wait_status() {
  local end=$((SECONDS + $3))
  while [ $SECONDS -lt $end ]; do
    [ "$(doc_status "$1")" = "$2" ] && return 0
    sleep 1
  done
  return 1
}

wait_health() {
  local end=$((SECONDS + ${1:-60})) code
  while [ $SECONDS -lt $end ]; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$API/health")
    [ "$code" = "200" ] && return 0
    sleep 1
  done
  return 1
}

# upload <pdf> [type]: POST /documents. Sets UP_CODE and UP_ID.
upload() {
  curl -s -o "$TMP/resp.json" -w '%{http_code}' -F "type=${2:-invoice}" -F "file=@$1" "$API/documents" >"$TMP/code.txt"
  UP_CODE=$(cat "$TMP/code.txt")
  UP_ID=$(jget id <"$TMP/resp.json")
}

# upload_version <doc_id> <pdf>: POST /documents/:id/versions. Sets UP_CODE, UP_ID (the document
# id from the summary it answers with) and UP_BODY.
upload_version() {
  curl -s -o "$TMP/resp.json" -w '%{http_code}' -F "file=@$2" "$API/documents/$1/versions" >"$TMP/code.txt"
  UP_CODE=$(cat "$TMP/code.txt")
  UP_BODY=$(cat "$TMP/resp.json")
  UP_ID=$(jget id <"$TMP/resp.json")
}

# fresh_pdf <name> [fixture]: a copy of the fixture (default invoice-001.v2.pdf) plus a unique
# trailing comment, so it is new bytes every run and never hits the identical-file path by accident.
fresh_pdf() {
  cp "fixtures/documents/${2:-invoice-001.v2.pdf}" "$TMP/$1.pdf"
  printf '\n%%verify-%s-%s\n' "$RANDOM$RANDOM" "$1" >>"$TMP/$1.pdf"
}

# require_fake_worker: exit 1 unless the worker runs the fake extractor slowly enough (>= 5 s) to
# leave a window for breaking things mid-extraction.
require_fake_worker() {
  local ext delay
  ext=$(docker compose exec -T worker printenv EXTRACTOR 2>/dev/null | tr -d '\r')
  delay=$(docker compose exec -T worker printenv FAKE_EXTRACTOR_DELAY_MS 2>/dev/null | tr -d '\r')
  if [ "$ext" != "fake" ] || ! [ "${delay:-0}" -ge 5000 ] 2>/dev/null; then
    echo "FAIL  worker must run with EXTRACTOR=fake FAKE_EXTRACTOR_DELAY_MS=15000 (got EXTRACTOR='$ext' delay='$delay')."
    echo "      Start it with: EXTRACTOR=fake FAKE_EXTRACTOR_DELAY_MS=15000 docker compose up -d worker"
    exit 1
  fi
  pass "precondition: api healthy, worker uses the fake extractor (delay ${delay} ms)"
}

# restore_worker_on_exit: on exit (pass or fail) remove the scratch dir and recreate the worker
# from .env and compose defaults. A failure of that step does not change the exit code.
restore_worker_on_exit() {
  trap _restore_worker EXIT
}
_restore_worker() {
  rm -r -f -- "$TMP"
  echo
  echo "restoring worker to normal settings (.env and compose defaults)..."
  if env -u EXTRACTOR -u FAKE_EXTRACTOR_DELAY_MS docker compose up -d worker >/dev/null 2>&1; then
    echo "worker restored"
  else
    echo "WARNING: could not restore the worker; run: docker compose up -d worker"
  fi
}

# summary: the closing line and exit code shared by the scripts.
summary() {
  echo
  if [ "$FAILS" -eq 0 ]; then
    echo "ALL CHECKS PASSED"
    exit 0
  fi
  echo "$FAILS CHECK(S) FAILED"
  exit 1
}
