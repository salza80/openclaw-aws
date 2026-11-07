#!/bin/bash
set -Eeuo pipefail
set +x
umask 077
export DEBIAN_FRONTEND=noninteractive
export AWS_REGION=@@REGION@@ AWS_DEFAULT_REGION=@@REGION@@
STACK_ID=@@STACK_ID@@
LOGICAL_RESOURCE_ID=@@LOGICAL_RESOURCE_ID@@
ROLE_NAME=@@ROLE_NAME@@
CFN_ROOT=/opt/openclaw-aws

# Fresh-install delivery only. Never overwrite an earlier managed installation.
[[ ! -e "$CFN_ROOT" && ! -L "$CFN_ROOT" ]]
mkdir -m 700 "$CFN_ROOT"
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates curl python3-venv python3-setuptools python3-wheel
python3 -m venv --system-site-packages "$CFN_ROOT/cfn-bootstrap"
cat > "$CFN_ROOT/requirements.txt" <<'CFN_REQUIREMENTS'
@@CFN_REQUIREMENTS@@
CFN_REQUIREMENTS
"$CFN_ROOT/cfn-bootstrap/bin/python" -m pip --isolated install \
  --disable-pip-version-check --no-cache-dir --no-deps --no-build-isolation \
  --require-hashes --index-url https://pypi.org/simple -r "$CFN_ROOT/requirements.txt"

launch_exit() {
  local status="$1"
  trap - EXIT
  if [[ "$status" -ne 0 ]]; then
    printf 'OPENCLAW_BOOTSTRAP FAILED phase=cloudformation-init exit=%s\n' "$status" >&2
    "$CFN_ROOT/cfn-bootstrap/bin/cfn-signal" --success false \
      --stack "$STACK_ID" --resource "$LOGICAL_RESOURCE_ID" \
      --region "$AWS_REGION" --role "$ROLE_NAME" || true
  fi
  exit "$status"
}
trap 'launch_exit $?' EXIT

# Only the payload's authenticated-health/inactive-restore gate signals success.
"$CFN_ROOT/cfn-bootstrap/bin/cfn-init" --stack "$STACK_ID" \
  --resource "$LOGICAL_RESOURCE_ID" --region "$AWS_REGION" \
  --role "$ROLE_NAME" --configsets default
