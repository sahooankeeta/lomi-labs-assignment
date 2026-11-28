#!/usr/bin/env bash
# Phase 4 chaos checks: break the running stack mid-extraction in the ways the spec lists and assert
# the end state through the HTTP API only (no SQL), as a client would see it.
#
#   A. worker restarted mid-extraction (SIGTERM handoff)
#   B. Redis FLUSHALL + worker and api restarted mid-extraction
#   C. the same file uploaded again after that restart
#   D. v2 uploaded while v1 is still extracting
#   E. document deleted mid-extraction
#   F. sweep: every document this run created is extracted with one value per field
#
# ASSUMES the compose stack is running with the fake extractor and a slow extraction, so there is a
# window to break things mid-extraction:
#
#   EXTRACTOR=fake FAKE_EXTRACTOR_DELAY_MS=15000 docker compose up -d
#   bash scripts/chaos.sh
#
# On exit (pass or fail) the worker is recreated from .env and compose defaults. Prints PASS/FAIL per
# check; exits 1 if any FAIL. Takes about 3 minutes. See scripts/lib.sh for the helpers.
#
# Wait budgets: the fake extraction takes 15 s; a restart hands the version back within the 15 s
# stop_grace_period (no 30 s lease wait); the reconciler re-enqueues queued versions and expired
# leases every <= 10 s. So 60 s to reach 'extracted' leaves room for one restart on the way.

cd "$(dirname "$0")/.." || exit 1

. scripts/lib.sh
restore_worker_on_exit

# Documents this run created, for the sweep. Only these: other documents in the database (a real
# Gemini upload that failed, say) are not this script's business.
CREATED=""

# values_ok <doc_id> <expected count>: the current version answers 200, is extracted, and has
# exactly <expected> values with no field twice. Prints a reason on failure.
values_ok() {
  local body
  body=$(api_get "/documents/$1") || { echo "GET failed"; return 1; }
  printf '%s' "$body" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const d=JSON.parse(s), want=Number(process.argv[1]);
      const fields=d.values.map(v=>v.field);
      const dup=fields.length!==new Set(fields).size;
      if(d.status!=="extracted"||fields.length!==want||dup){
        console.log(`status=${d.status} values=${fields.length} want=${want} duplicates=${dup}`);process.exit(1);
      }
    })' "$2"
}

# broke <label> <command...>: run a chaos action. Fails the check (returns 1) when the command
# fails: nothing was broken, so a later PASS would prove nothing.
broke() {
  local label=$1
  shift
  "$@" >/dev/null 2>&1 && return 0
  fail "$label. chaos action failed: $*"
  return 1
}

# not_finished <label> <doc_id>: right after a break, the document must still be unfinished, or the
# break landed after the extraction and the scenario interrupted nothing.
not_finished() {
  [ "$(doc_status "$2")" != "extracted" ] && return 0
  fail "$1. document was already extracted when the stack was broken; nothing was interrupted"
  return 1
}

# start_extracting <name> [fixture]: upload fresh bytes and wait for 'extracting'. Sets DOC.
start_extracting() {
  fresh_pdf "$1" "${2:-}"
  upload "$TMP/$1.pdf" invoice
  DOC=$UP_ID
  CREATED="$CREATED $DOC"
  [ "$UP_CODE" = "201" ] && [ -n "$DOC" ] && wait_status "$DOC" extracting 30
}

# ---- 0. preconditions -------------------------------------------------------------------------
if ! wait_health 60; then
  echo "FAIL  api /health did not return 200 within 60 s"
  exit 1
fi
# 15 s, not lib.sh's 5 s default: every break below must land while the extraction is running.
require_fake_worker 15000

# ---- A. restart the worker mid-extraction -----------------------------------------------------
# `restart` sends SIGTERM: the worker hands the version back to 'queued' without spending an
# attempt, and the reconciler picks it up again.
if start_extracting chaos-a; then
  if broke A docker compose restart worker && not_finished A "$DOC"; then
    r=bad
    wait_status "$DOC" extracted 60 && why=$(values_ok "$DOC" 5) && r=ok
    check "$r" "A. worker restarted mid-extraction: extracted with 5 values" "status=$(doc_status "$DOC") $why"
  fi
else
  fail "A. upload never reached 'extracting' (code=$UP_CODE status=$(doc_status "$DOC"))"
fi

# ---- B. FLUSHALL + restart worker and api mid-extraction ----------------------------------------
# Redis loses every job; Postgres still says 'extracting', so the reconciler re-enqueues it once
# the lease expires or the handoff requeues it.
if start_extracting chaos-b; then
  B_DOC=$DOC
  if broke B docker compose exec -T redis redis-cli FLUSHALL &&
    broke B docker compose restart worker api && wait_health 60 && not_finished B "$DOC"; then
    r=bad
    wait_status "$DOC" extracted 60 && why=$(values_ok "$DOC" 5) && r=ok
    check "$r" "B. FLUSHALL + restart worker and api: extracted with 5 values" "status=$(doc_status "$DOC") $why"
  fi
else
  B_DOC=""
  fail "B. upload never reached 'extracting' (code=$UP_CODE status=$(doc_status "$DOC"))"
fi

# ---- C. double upload, after the restart --------------------------------------------------------
# Dedup lives in Postgres (unique sha256), so the restarted api must still recognise the file.
if [ -n "$B_DOC" ]; then
  upload "$TMP/chaos-b.pdf" invoice
  n=$(api_get "/documents/$B_DOC/versions" | jlen .)
  [ "$UP_CODE" = "200" ] && [ "$UP_ID" = "$B_DOC" ] && [ "$n" = "1" ] && r=ok || r=bad
  check "$r" "C. same file again: 200, same document, still one version" "code=$UP_CODE id=$UP_ID expected=$B_DOC versions=$n"
else
  fail "C. skipped: scenario B has no document"
fi

# ---- D. v2 while v1 is extracting ---------------------------------------------------------------
# v1 is superseded at once; its run notices at its next ownership check and writes nothing. v2 then
# extracts with no previous links: v1 never extracted, so there is nothing to carry (rule 12).
if start_extracting chaos-d1 invoice-001.pdf; then
  fresh_pdf chaos-d2 invoice-001.v2.pdf
  upload_version "$DOC" "$TMP/chaos-d2.pdf"
  check "$([ "$UP_CODE" = "201" ] && echo ok)" "D1. v2 upload during v1 answers 201" "code=$UP_CODE body=$UP_BODY"
  wait_status "$DOC" extracted 60 && why=$(values_ok "$DOC" 5) && r=ok || r=bad
  check "$r" "D2. v2 extracted with 5 values" "status=$(doc_status "$DOC") $why"

  cur=$(api_get "/documents/$DOC")
  vs=$(api_get "/documents/$DOC/versions")
  v1=$(api_get "/documents/$DOC?version=1")
  # Both the exit status and the OK are required: a checker that crashes prints neither.
  why=$(supersede_problems "$cur" "$vs" "$v1") && [ "$why" = OK ] && r=ok || r=bad
  check "$r" "D3. v1 superseded with no values; v2 current, no links to v1" "$why"
else
  fail "D. v1 upload never reached 'extracting' (code=$UP_CODE status=$(doc_status "$DOC"))"
fi

# ---- E. delete mid-extraction -------------------------------------------------------------------
# The run's next ownership check (or lease renewal) fails and it stops; the worker must stay usable.
if start_extracting chaos-e; then
  E_DOC=$DOC
  CREATED=${CREATED% "$E_DOC"} # deleted on purpose: not part of the sweep
  code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$API/documents/$E_DOC")
  after=$(curl -s -o /dev/null -w '%{http_code}' "$API/documents/$E_DOC")
  [ "$code" = "204" ] && [ "$after" = "404" ] && r=ok || r=bad
  check "$r" "E1. delete mid-extraction answers 204, then the document is 404" "delete=$code get=$after"
  # Two uploads at once, both done within one extraction window. The worker runs 2 versions at a
  # time, so this fails if the deleted run still holds a slot: one upload would queue behind it.
  # First let the deleted run's in-flight extract call (<= 15 s) return: it only stops at its next
  # ownership check, so until then it holds its slot by design.
  sleep 20
  fresh_pdf chaos-e2
  fresh_pdf chaos-e3
  upload "$TMP/chaos-e2.pdf" invoice
  E2=$UP_ID E2_CODE=$UP_CODE
  upload "$TMP/chaos-e3.pdf" invoice
  E3=$UP_ID E3_CODE=$UP_CODE
  CREATED="$CREATED $E2 $E3"
  # 15 s fake extraction + pick-up and polling slack; two runs in series would need 30 s or more.
  r=bad
  [ "$E2_CODE" = "201" ] && [ "$E3_CODE" = "201" ] && wait_status "$E2" extracted 28 &&
    wait_status "$E3" extracted 2 && why=$(values_ok "$E2" 5) && why=$(values_ok "$E3" 5) && r=ok
  check "$r" "E2. two uploads after the delete extract side by side (no slot stuck on the deleted run)" "codes=$E2_CODE,$E3_CODE status=$(doc_status "$E2"),$(doc_status "$E3") $why"
else
  fail "E. upload never reached 'extracting' (code=$UP_CODE status=$(doc_status "$DOC"))"
fi

# ---- F. sweep -------------------------------------------------------------------------------------
# Every document this run created must be listed and extracted with one value per field. A run that
# created nothing fails here rather than passing on an empty loop.
list=$(api_get /documents) || list=""
bad=""
n=0
for id in $CREATED; do
  n=$((n + 1))
  printf '%s' "$list" | grep -q "\"id\":\"$id\"" || { bad="$bad $id:not-listed"; continue; }
  why=$(values_ok "$id" 5) || bad="$bad $id:$why"
done
[ "$n" -gt 0 ] && [ -n "$list" ] && [ -z "$bad" ] && r=ok || r=bad
check "$r" "F. sweep: all $n documents this run created are listed and extracted, one value per field" "${bad:-created=$n list=${#list} bytes}"

summary
