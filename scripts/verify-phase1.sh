#!/usr/bin/env bash
# Phase 1 end-to-end verification: restart safety, FLUSHALL, double upload, SIGKILL, no duplicates.
#
# ASSUMES the stack is already running with the fake extractor and a slow extraction, so there is
# a window to break things mid-extraction:
#
#   EXTRACTOR=fake FAKE_EXTRACTOR_DELAY_MS=15000 docker compose up -d
#   bash scripts/verify-phase1.sh
#
# On exit (pass or fail) the script restores the worker to your normal settings itself
# (`env -u EXTRACTOR -u FAKE_EXTRACTOR_DELAY_MS docker compose up -d worker`, i.e. from .env and
# compose defaults). A failure of that step does not change the exit code.
#
# The script fails fast if the worker is not using the fake extractor. Needs bash, curl, node and
# docker compose (Git Bash on Windows works). Prints PASS/FAIL per check; exits 1 if any FAIL.

cd "$(dirname "$0")/.." || exit 1

API="${API_URL:-http://localhost:3000}"
FAILS=0
TMP=".verify-tmp"
mkdir -p "$TMP"
cleanup() {
  rm -r -f -- "$TMP"
  echo
  echo "restoring worker to normal settings (.env and compose defaults)..."
  if env -u EXTRACTOR -u FAKE_EXTRACTOR_DELAY_MS docker compose up -d worker >/dev/null 2>&1; then
    echo "worker restored"
  else
    echo "WARNING: could not restore the worker; run: docker compose up -d worker"
  fi
}
trap cleanup EXIT

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILS=$((FAILS + 1)); }
check() { if [ "$1" = "ok" ]; then pass "$2"; else fail "$2 ($3)"; fi; }

# psql_q <sql>: prints the result; on any docker/psql failure prints the error to stderr and returns 1.
psql_q() {
  local out
  out=$(docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U lomi -d lomi -tA -c "$1") || {
    echo "psql_q failed: $1" >&2
    return 1
  }
  printf '%s' "$out" | tr -d '\r'
}

# jget <dotted.path>: read JSON on stdin, print the value (empty if missing or invalid).
jget() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v==null?v:v[k];console.log(v==null?"":v)}catch{console.log("")}})' "$1"
}

doc_status() { curl -s "$API/documents/$1" | jget status; }

# wait_status <id> <status> <seconds>: poll until the document reaches the status.
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

# upload <pdf> [type]: sets UP_CODE and UP_ID.
upload() {
  curl -s -o "$TMP/resp.json" -w '%{http_code}' -F "type=${2:-invoice}" -F "file=@$1" "$API/documents" >"$TMP/code.txt"
  UP_CODE=$(cat "$TMP/code.txt")
  UP_ID=$(jget id <"$TMP/resp.json")
}

# fresh_pdf <name>: invoice-001.v2.pdf plus a unique trailing comment, so it is new bytes every run.
fresh_pdf() {
  cp fixtures/documents/invoice-001.v2.pdf "$TMP/$1.pdf"
  printf '\n%%verify-%s-%s\n' "$RANDOM$RANDOM" "$1" >>"$TMP/$1.pdf"
}

# ---- 0. preconditions -------------------------------------------------------------------------
if ! wait_health 60; then
  echo "FAIL  api /health did not return 200 within 60 s"
  exit 1
fi
EXT=$(docker compose exec -T worker printenv EXTRACTOR 2>/dev/null | tr -d '\r')
DELAY=$(docker compose exec -T worker printenv FAKE_EXTRACTOR_DELAY_MS 2>/dev/null | tr -d '\r')
if [ "$EXT" != "fake" ] || [ "${DELAY:-0}" -lt 5000 ] 2>/dev/null; then
  echo "FAIL  worker must run with EXTRACTOR=fake FAKE_EXTRACTOR_DELAY_MS=15000 (got EXTRACTOR='$EXT' delay='$DELAY')."
  echo "      Start it with: EXTRACTOR=fake FAKE_EXTRACTOR_DELAY_MS=15000 docker compose up -d worker"
  exit 1
fi
pass "precondition: api healthy, worker uses the fake extractor (delay ${DELAY} ms)"

# ---- 1. seeded documents extract ----------------------------------------------------------------
SEEDED=""
for t in invoice lease market_report; do
  id=$(psql_q "select d.id from documents d join document_versions v on v.document_id = d.id and v.version_no = 1 where d.type = '$t' order by d.created_at limit 1")
  SEEDED="$SEEDED $id"
done
ok=ok
for id in $SEEDED; do
  [ -n "$id" ] && wait_status "$id" extracted 60 || ok=bad
done
check "$ok" "1. all three seeded documents reach 'extracted' within 60 s" "ids:$SEEDED"

# ---- 2. restart worker mid-extraction ---------------------------------------------------------
fresh_pdf restart
upload "$TMP/restart.pdf" invoice
RESTART_ID=$UP_ID
[ "$UP_CODE" = "201" ] && [ -n "$RESTART_ID" ] && pass "2a. new invoice upload returns 201" || fail "2a. new invoice upload returns 201 (got $UP_CODE)"
if wait_status "$RESTART_ID" extracting 30; then
  docker compose restart worker >/dev/null 2>&1
  wait_status "$RESTART_ID" extracted 60 && r=ok || r=bad
  check "$r" "2b. worker restarted while extracting: ends 'extracted' within 60 s" "status=$(doc_status "$RESTART_ID")"
else
  fail "2b. document never reached 'extracting' (status=$(doc_status "$RESTART_ID"))"
fi

# ---- 3. double upload ---------------------------------------------------------------------------
SHA=$(node -e 'const c=require("crypto"),fs=require("fs");console.log(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$TMP/restart.pdf")
upload "$TMP/restart.pdf" invoice
[ "$UP_CODE" = "200" ] && [ "$UP_ID" = "$RESTART_ID" ] && r=ok || r=bad
check "$r" "3a. second upload of the same file returns 200 and the same id" "code=$UP_CODE id=$UP_ID expected=$RESTART_ID"
n=$(psql_q "select count(*) from document_versions where sha256 = '$SHA'")
[ "$n" = "1" ] && r=ok || r=bad
check "$r" "3b. database has exactly one version for that file" "count=$n"

# ---- 4. FLUSHALL + restart worker and api -------------------------------------------------------
fresh_pdf flush
upload "$TMP/flush.pdf" invoice
FLUSH_ID=$UP_ID
if wait_status "$FLUSH_ID" extracting 30; then
  docker compose exec -T redis redis-cli FLUSHALL >/dev/null 2>&1
  docker compose restart worker api >/dev/null 2>&1
  wait_health 60 || true
  wait_status "$FLUSH_ID" extracted 60 && r=ok || r=bad
  check "$r" "4. FLUSHALL + restart worker and api mid-extraction: ends 'extracted' within 60 s" "status=$(doc_status "$FLUSH_ID")"
else
  fail "4. document never reached 'extracting' (status=$(doc_status "$FLUSH_ID"))"
fi

# ---- 5. SIGKILL the worker mid-extraction ---------------------------------------------------------
fresh_pdf kill
upload "$TMP/kill.pdf" invoice
KILL_ID=$UP_ID
if wait_status "$KILL_ID" extracting 30; then
  docker compose kill -s SIGKILL worker >/dev/null 2>&1
  docker compose start worker >/dev/null 2>&1   # start, not up: keeps the fake-extractor env
  # 30 s lease + up to 10 s reconciler tick + 15 s fake extraction, with some slack.
  wait_status "$KILL_ID" extracted 90 && r=ok || r=bad
  check "$r" "5. worker SIGKILLed mid-extraction: ends 'extracted' after lease expiry (<= 90 s)" "status=$(doc_status "$KILL_ID")"
else
  fail "5. document never reached 'extracting' (status=$(doc_status "$KILL_ID"))"
fi

# ---- 6. no duplicate or missing values --------------------------------------------------------------
q6ok=ok
# Positive assertion that the queries really ran: there must be extracted versions to check.
n_extracted=$(psql_q "select count(*) from document_versions where status = 'extracted'") || q6ok=bad
case "$n_extracted" in '' | *[!0-9]* | 0) q6ok=bad ;; esac
bad=$(psql_q "select ev.version_id || ' has ' || count(*) from extracted_values ev join document_versions v on v.id = ev.version_id join documents d on d.id = v.document_id group by ev.version_id, d.type having count(*) <> case d.type::text when 'market_report' then 6 else 5 end") || q6ok=bad
empty=$(psql_q "select v.id from document_versions v where v.status = 'extracted' and not exists (select 1 from extracted_values ev where ev.version_id = v.id)") || q6ok=bad
dups=$(psql_q "select version_id from extracted_values group by version_id, field having count(*) > 1") || q6ok=bad
if [ "$q6ok" != ok ]; then
  fail "6. database queries failed or found no extracted versions (count='$n_extracted'); not treating empty results as a pass"
elif [ -z "$bad" ] && [ -z "$empty" ] && [ -z "$dups" ]; then
  pass "6. every version has exactly one value per field (no duplicates, none missing)"
else
  fail "6. value counts wrong: wrong-count='$bad' extracted-without-values='$empty' duplicates='$dups'"
fi

echo
if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILS CHECK(S) FAILED"
exit 1
