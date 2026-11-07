if [[ -e "$STATE_DIR/openclaw.json" ]]; then
  phase preserve-state
  # Preserve existing native state.
  as_ubuntu "$OPENCLAW_BIN" gateway install --force
else
  phase secrets
  if [[ -e "$STATE_DIR/.env" ]]; then
    printf 'ERROR: existing OpenClaw environment without configuration; back up ~/.openclaw/.env, then complete onboarding manually or move it aside before retrying setup\n' >&2
    exit 1
  fi
  : > "$WORK_DIR/openclaw.env"
  @@PROVIDER_KEY_SETUP@@
  @@ADDITIONAL_PROVIDER_SETUP@@
  fetch_parameter @@GATEWAY_TOKEN_PARAM_NAME@@ "$WORK_DIR/gateway-token.json"
  GATEWAY_TOKEN="$(jq -er '.Parameter.Value' "$WORK_DIR/gateway-token.json")"
  write_dotenv_entry OPENCLAW_GATEWAY_TOKEN "$GATEWAY_TOKEN" >> "$WORK_DIR/openclaw.env"
  install -o ubuntu -g ubuntu -m 600 "$WORK_DIR/openclaw.env" "$STATE_DIR/.env"
  unset API_KEY GATEWAY_TOKEN
  @@LOGGING_CONFIG@@
  phase onboarding
  auth_args=(@@AUTH_ARGS@@)
  as_ubuntu "$OPENCLAW_BIN" onboard --non-interactive --accept-risk --json \
    --mode local "${auth_args[@]}" --secret-input-mode ref \
    --gateway-port 18789 --gateway-bind loopback --gateway-auth token \
    --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN --install-daemon --daemon-runtime node \
    --skip-skills --skip-channels --skip-search --skip-hooks --skip-ui --skip-health \
    --suppress-gateway-token-output > "$WORK_DIR/onboard.json" 2> "$WORK_DIR/onboard.err"
  @@MODEL_SETUP@@
  @@ADDITIONAL_PROVIDER_AUTH@@
fi

phase service
for attempt in {1..30}; do
  if as_ubuntu systemctl --user is-active --quiet openclaw-gateway.service; then break; fi
  sleep 1
done
as_ubuntu systemctl --user is-active --quiet openclaw-gateway.service
phase readiness
# Authenticated readiness RPC; no inference.
wait_for_health
BOOTSTRAP_READY=1
