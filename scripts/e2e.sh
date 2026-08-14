#!/usr/bin/env bash
# Search1API DSH plugin — end-to-end regression.
#
# Verifies the full chain in an isolated DSH home (never touches ~/.dsh):
#   build -> bundle install/reconcile -> config compose -> plugin load -> real tool call.
#
# Tunables (env-overridable):
#   DSH_BIN             path to the `dsh` binary (default: from PATH)
#   S1_E2E_HOME         isolated home to use (default: $PLUGIN_DIR/.dsh-e2e)
#   DSH_PROFILE         profile to test (default: headless)
#   S1_E2E_QUERY        search query for the live call (default: OpenAI)
#   S1_E2E_COMPOSE_ONLY=1   stop after the config-compose check (no LLM needed)
#
# Credentials:
#   S1_KEY is read from $S1_KEY, then $PLUGIN_DIR/.env,
#   then the parent directory's .env.
#   LLM credentials (for the headless run) are copied from ~/.dsh if present.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARENT_DIR="$(dirname "$PLUGIN_DIR")"

DSH_BIN="${DSH_BIN:-$(command -v dsh || true)}"
TEST_HOME="${S1_E2E_HOME:-$PLUGIN_DIR/.dsh-e2e}"
PROFILE="${DSH_PROFILE:-headless}"
QUERY="${S1_E2E_QUERY:-OpenAI}"
COMPOSE_ONLY="${S1_E2E_COMPOSE_ONLY:-0}"

log() { printf '\033[36m[e2e]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[e2e] FAIL\033[0m %s\n' "$*" >&2; exit 1; }

# --- resolve dsh ---
if [ -z "$DSH_BIN" ] || [ ! -x "$DSH_BIN" ]; then
  die "dsh binary not found. Install @deepseek-ai/dsh or set DSH_BIN=/path/to/dsh"
fi
log "dsh:      $DSH_BIN"
log "home:     $TEST_HOME"
log "profile:  $PROFILE"

# --- resolve S1_KEY ---
API_KEY="${S1_KEY:-}"
for f in "$PLUGIN_DIR/.env" "$PARENT_DIR/.env"; do
  if [ -z "$API_KEY" ] && [ -f "$f" ]; then
    API_KEY="$(sed -n 's/^S1_KEY=//p' "$f")"
    [ -n "$API_KEY" ] && log "loaded S1_KEY from $f"
  fi
done
[ -n "$API_KEY" ] || die "S1_KEY not found. Set the env var or put it in .env"

# --- build ---
log "building plugin"
(cd "$PLUGIN_DIR" && npm run build)

# --- isolated home + LLM credentials (best-effort) ---
mkdir -p "$TEST_HOME"
for f in .credentials.yaml settings.yaml; do
  if [ ! -e "$TEST_HOME/$f" ] && [ -e "$HOME/.dsh/$f" ]; then
    cp "$HOME/.dsh/$f" "$TEST_HOME/$f"
    log "copied $f from ~/.dsh (LLM credentials)"
  fi
done

# --- install plugin into the profile (reconciles dsh.profile.bundles) ---
log "installing plugin into $PROFILE profile"
DSH_HOME="$TEST_HOME" "$DSH_BIN" plugin --profile "$PROFILE" add "file:$PLUGIN_DIR"

# Refresh the file: copy with the freshly built lib (pnpm re-links from source).
if command -v pnpm >/dev/null 2>&1; then
  (cd "$TEST_HOME/profiles/$PROFILE" && pnpm install --silent) || true
fi

# --- config compose check ---
log "verifying config composition"
if ! DSH_HOME="$TEST_HOME" "$DSH_BIN" --profile "$PROFILE" --dump-config | grep -q "s1-tools"; then
  die "s1-tools row not found in composed config"
fi
log "compose OK: s1-tools row present"

# --- optional: skip the live call ---
if [ "$COMPOSE_ONLY" = "1" ]; then
  log "S1_E2E_COMPOSE_ONLY set; skipping live tool call"
  log "PASS (compose)"
  exit 0
fi

# --- live headless run: make the model actually call s1_search ---
log "running live E2E: s1_search(\"$QUERY\")"
task="Use ONLY your s1_search tool to search the web for \"$QUERY\". List the top 3 result titles and URLs. Do not use any other method."
set +e
OUTPUT="$(S1_KEY="$API_KEY" DSH_HOME="$TEST_HOME" "$DSH_BIN" --profile "$PROFILE" "$task" 2>&1)"
rc=$?
set -e
printf '%s\n' "$OUTPUT"

[ $rc -eq 0 ] || die "headless run exited with code $rc"
if printf '%s' "$OUTPUT" | grep -qiE "unable to complete|missing api key"; then
  die "s1_search reported an error"
fi
if ! printf '%s' "$OUTPUT" | grep -qE "https?://"; then
  die "no URLs in output — s1_search may not have returned live results"
fi

log "PASS: s1_search returned live results"
