#!/bin/bash
set -Eeuo pipefail
set +x
umask 077
export AWS_REGION=@@REGION@@
export AWS_DEFAULT_REGION="$AWS_REGION"
export AWS_PAGER=''
export AWS_RETRY_MODE=standard AWS_MAX_ATTEMPTS=3
STACK_ID=@@STACK_ID@@
LOGICAL_RESOURCE_ID=@@LOGICAL_RESOURCE_ID@@
PHASE=initializing
BOOTSTRAP_READY=0
WORK_DIR=''
INSTALL_DIR=''
INSTANCE_ID=''
SETUP_MARKER=/tmp/openclaw-setup-complete
trap 'on_exit $?' EXIT

phase() {
  PHASE="$1"
  printf 'OPENCLAW_BOOTSTRAP phase=%s\n' "$PHASE"
}

signal_result() {
  local status="$1" attempt imds_token
  command -v aws >/dev/null 2>&1 || return 1
  if [[ -z "$INSTANCE_ID" ]]; then
    imds_token="$(curl -fsS --connect-timeout 3 --max-time 5 --retry 2 -X PUT \
      -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
      http://169.254.169.254/latest/api/token)" || return 1
    INSTANCE_ID="$(printf 'header = "X-aws-ec2-metadata-token: %s"\n' "$imds_token" | \
      curl -fsS --connect-timeout 3 --max-time 5 --retry 2 --config - \
      http://169.254.169.254/latest/meta-data/instance-id)" || return 1
    [[ "$INSTANCE_ID" == i-* ]] || return 1
  fi
  for attempt in 1 2 3 4 5; do
    if aws cloudformation signal-resource --stack-name "$STACK_ID" \
      --logical-resource-id "$LOGICAL_RESOURCE_ID" --unique-id "$INSTANCE_ID" \
      --status "$status" --region "$AWS_REGION" \
      --cli-connect-timeout 5 --cli-read-timeout 10 >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

on_exit() {
  local original_code="$1" result_code="$1"
  trap - EXIT
  set +e
  if [[ "$original_code" -eq 0 && "$BOOTSTRAP_READY" -eq 1 ]]; then
    if signal_result SUCCESS; then
      touch "$SETUP_MARKER" 2>/dev/null || printf 'OPENCLAW_BOOTSTRAP warning: completion marker unavailable\n' >&2
      printf 'OPENCLAW_BOOTSTRAP READY\n'
    else
      printf 'OPENCLAW_BOOTSTRAP FAILED phase=signal\n' >&2
      result_code=1
    fi
  else
    [[ "$result_code" -ne 0 ]] || result_code=1
    printf 'OPENCLAW_BOOTSTRAP FAILED phase=%s exit=%s\n' "$PHASE" "$result_code" >&2
    signal_result FAILURE || printf 'OPENCLAW_BOOTSTRAP failure signal unavailable\n' >&2
  fi
  [[ -z "$WORK_DIR" ]] || rm -rf -- "$WORK_DIR"
  [[ -z "$INSTALL_DIR" ]] || rm -rf -- "$INSTALL_DIR"
  exit "$result_code"
}

download() {
  curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 300 \
    --retry 3 --retry-delay 2 "$1" -o "$2"
}

as_ubuntu() {
  sudo -H -u ubuntu env XDG_RUNTIME_DIR="/run/user/$UBUNTU_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$UBUNTU_UID/bus" \
    PATH='/home/ubuntu/.openclaw/bin:/home/ubuntu/.openclaw/tools/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
    "$@"
}

write_dotenv_entry() {
  local name="$1" value="$2"
  if [[ -z "$value" || "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    printf 'ERROR: credential must be a nonempty single-line value\n' >&2
    return 1
  fi
  # dotenv preserves literal backslashes inside single quotes and backticks.
  # Choosing an absent delimiter avoids silently changing a credential's bytes.
  if [[ "$value" != *"'"* ]]; then
    printf "%s='%s'\n" "$name" "$value"
  elif [[ "$value" != *'`'* ]]; then
    printf '%s=`%s`\n' "$name" "$value"
  else
    printf 'ERROR: credential cannot be represented safely in the state environment file\n' >&2
    return 1
  fi
}

fetch_parameter() {
  local name="$1" destination="$2"
  aws ssm get-parameter --with-decryption --name "$name" --region "$AWS_REGION" \
    --cli-connect-timeout 5 --cli-read-timeout 15 --output json > "$destination"
  if ! jq -e '.Parameter.Value | if type == "string" then (length > 0) and (test("[\u0000\r\n]") | not) else false end' \
    "$destination" >/dev/null 2>&1; then
    printf 'ERROR: SSM credential is missing or contains unsupported control characters\n' >&2
    return 1
  fi
}

wait_for_health() {
  local attempt
  for attempt in {1..30}; do
    if as_ubuntu "$OPENCLAW_BIN" health --json --timeout 10000 \
      > "$WORK_DIR/health.json" 2> "$WORK_DIR/health.err"; then
      if jq -e '.ok == true' "$WORK_DIR/health.json" >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 2
  done
  printf 'ERROR: authenticated gateway health did not become ready\n' >&2
  return 1
}

rm -f -- "$SETUP_MARKER"
phase dependencies
[[ "$(uname -m)" == x86_64 ]]
WORK_DIR="$(mktemp -d /tmp/openclaw-bootstrap.XXXXXX)"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends curl git jq unzip ca-certificates

phase awscli
if ! command -v aws >/dev/null 2>&1; then
  download https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip "$WORK_DIR/awscliv2.zip"
  unzip -q "$WORK_DIR/awscliv2.zip" -d "$WORK_DIR"
  "$WORK_DIR/aws/install" --update
fi
aws --version

phase ssm
if systemctl cat snap.amazon-ssm-agent.amazon-ssm-agent.service >/dev/null 2>&1; then
  systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent.service
elif systemctl cat amazon-ssm-agent.service >/dev/null 2>&1; then
  systemctl enable --now amazon-ssm-agent.service
else
  download "https://s3.${AWS_REGION}.amazonaws.com/amazon-ssm-${AWS_REGION}/latest/debian_amd64/amazon-ssm-agent.deb" "$WORK_DIR/ssm.deb"
  dpkg -i "$WORK_DIR/ssm.deb"
  systemctl enable --now amazon-ssm-agent.service
fi

@@CLOUDWATCH_SETUP@@

phase installer
OPENCLAW_VERSION=@@OPENCLAW_VERSION@@
NODE_VERSION=@@NODE_VERSION@@
STATE_DIR=/home/ubuntu/.openclaw
OPENCLAW_BIN="$STATE_DIR/bin/openclaw"
NODE_BIN="$STATE_DIR/tools/node/bin/node"
UBUNTU_UID="$(id -u ubuntu)"
install -d -o ubuntu -g ubuntu -m 700 "$STATE_DIR" "$STATE_DIR/logs"
INSTALL_DIR="$(mktemp -d /home/ubuntu/.openclaw-installer.XXXXXX)"
# Both files are from the exact v2026.11.1 commit. Source entrypoints require
# the sibling policy; the mutable website installer is intentionally avoided.
INSTALLER_BASE=https://raw.githubusercontent.com/openclaw/openclaw/4ffdd2047d192dd65554de3c8c46c0e0197c6e2a/scripts
download "$INSTALLER_BASE/install-cli.sh" "$INSTALL_DIR/install-cli.sh"
download "$INSTALLER_BASE/install-policy.sh" "$INSTALL_DIR/install-policy.sh"
printf '%s  %s\n' \
  d3e5e557c6364da0308a0a88b506db70e1cc0639b3ab7b04d0bc168540e80f38 "$INSTALL_DIR/install-cli.sh" \
  704d74675d3d61e8856e3461f8f4713fdfe8c154797b0c31876d030662879cc6 "$INSTALL_DIR/install-policy.sh" | sha256sum -c -
chown -R ubuntu:ubuntu "$INSTALL_DIR"
as_ubuntu bash "$INSTALL_DIR/install-cli.sh" --json --prefix "$STATE_DIR" \
  --version "$OPENCLAW_VERSION" --node-version "$NODE_VERSION" --no-onboard --runtime-only
[[ "$(as_ubuntu id -un)" == ubuntu ]]
[[ "$(as_ubuntu "$NODE_BIN" -p 'process.version')" == "v$NODE_VERSION" ]]
as_ubuntu "$OPENCLAW_BIN" --version
as_ubuntu "$NODE_BIN" -e \
  'const fs=require("node:fs"); if(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version!==process.argv[2]) process.exit(1)' \
  "$STATE_DIR/tools/node-v$NODE_VERSION/lib/node_modules/openclaw/package.json" "$OPENCLAW_VERSION"
if ! grep -qF '/home/ubuntu/.openclaw/bin' /home/ubuntu/.bashrc; then
  printf '%s\n' 'export PATH="$HOME/.openclaw/bin:$HOME/.openclaw/tools/node/bin:$PATH"' >> /home/ubuntu/.bashrc
fi

phase user-services
loginctl enable-linger ubuntu
systemctl start "user@$UBUNTU_UID.service"
for attempt in {1..30}; do
  if as_ubuntu systemctl --user show-environment >/dev/null 2>&1; then break; fi
  sleep 1
done
as_ubuntu systemctl --user show-environment >/dev/null

if [[ -e "$STATE_DIR/openclaw.json" ]]; then
  phase preserve-state
  # Reruns retain the existing config, credentials, sessions and workspace.
  as_ubuntu "$OPENCLAW_BIN" gateway install --force
else
  phase secrets
  if [[ -e "$STATE_DIR/.env" ]]; then
    printf 'ERROR: existing OpenClaw environment without configuration; back up ~/.openclaw/.env, then complete onboarding manually or move it aside before retrying setup\n' >&2
    exit 1
  fi
  fetch_parameter @@API_KEY_PARAM_NAME@@ "$WORK_DIR/api-key.json"
  fetch_parameter @@GATEWAY_TOKEN_PARAM_NAME@@ "$WORK_DIR/gateway-token.json"
  API_KEY="$(jq -er '.Parameter.Value' "$WORK_DIR/api-key.json")"
  GATEWAY_TOKEN="$(jq -er '.Parameter.Value' "$WORK_DIR/gateway-token.json")"
  write_dotenv_entry @@PROVIDER_ENV@@ "$API_KEY" > "$WORK_DIR/openclaw.env"
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
fi

phase service
for attempt in {1..30}; do
  if as_ubuntu systemctl --user is-active --quiet openclaw-gateway.service; then break; fi
  sleep 1
done
as_ubuntu systemctl --user is-active --quiet openclaw-gateway.service
phase readiness
# This is an authenticated health RPC, without a paid model inference probe.
# A zero exit status with status=starting is not a ready health snapshot.
wait_for_health
BOOTSTRAP_READY=1
