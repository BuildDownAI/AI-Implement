#!/usr/bin/env bash
#
# Environment-aware terraform wrapper. The environment is the only parameter
# besides the AWS profile — it selects both the state location
# (envs/<env>.backend.hcl) and the per-env values (locals.tf env_config).
#
# Usage:
#   AWS_PROFILE=<profile> ./tf.sh <dev|prod> <terraform-command> [args...]
#
#   ./tf.sh dev init                 # explicit init (also: -reconfigure, -upgrade, ...)
#   ./tf.sh dev plan
#   ./tf.sh prod apply
#   ./tf.sh dev output -raw route53_zone_id
#
# Each environment keeps its own working directory (.terraform-<env>) so
# switching between dev and prod never reuses the other's cached backend.
# Commands other than init auto-init first if the env was never initialized.
set -euo pipefail

usage() {
  echo "Usage: AWS_PROFILE=<profile> $0 <dev|prod> <terraform-command> [args...]" >&2
  exit 1
}

[[ $# -ge 2 ]] || usage
ENV="$1"
shift
CMD="$1"
shift

case "$ENV" in
  dev|prod) ;;
  *) echo "Unknown environment '$ENV' (expected dev or prod)" >&2; usage ;;
esac

: "${AWS_PROFILE:?Set AWS_PROFILE to the AWS CLI profile for the $ENV account}"

cd "$(dirname "$0")"
export TF_DATA_DIR=".terraform-$ENV"

run_init() {
  terraform init \
    -backend-config="envs/$ENV.backend.hcl" \
    -backend-config="profile=$AWS_PROFILE" \
    "$@"
}

if [[ "$CMD" == "init" ]]; then
  run_init "$@"
  exit 0
fi

# Auto-init on first use of this environment.
if [[ ! -f "$TF_DATA_DIR/terraform.tfstate" ]]; then
  echo "[$ENV] not initialized yet; running terraform init" >&2
  run_init
fi

# Only commands that evaluate the configuration accept -var.
case "$CMD" in
  plan|apply|destroy|refresh|import|console)
    exec terraform "$CMD" \
      -var "environment=$ENV" \
      -var "aws_profile=$AWS_PROFILE" \
      "$@"
    ;;
  *)
    exec terraform "$CMD" "$@"
    ;;
esac
