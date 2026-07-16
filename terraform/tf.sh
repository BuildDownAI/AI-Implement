#!/usr/bin/env bash
#
# Environment-aware terraform wrapper. The environment is the only parameter
# besides the AWS profile — it selects both the state location
# (envs/<env>.backend.hcl) and the per-env values (locals.tf env_config).
#
# On init (explicit or the auto-init before the first plan/apply of an env),
# it bootstraps the S3 state bucket named in envs/<env>.backend.hcl if it does
# not already exist — creating it with versioning, AES256 default encryption,
# and a public-access block. This is idempotent: if the bucket is already
# present it is left untouched. Set TF_SKIP_BOOTSTRAP=1 to skip the check.
#
# Usage:
#   AWS_PROFILE=<profile> ./tf.sh <dev|prod> <terraform-command> [args...]
#
#   ./tf.sh dev init                 # explicit init (also: -reconfigure, -upgrade, ...)
#   ./tf.sh dev plan
#   ./tf.sh prod apply
#   ./tf.sh dev output -raw route53_public_zone_id
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

BACKEND_FILE="envs/$ENV.backend.hcl"

# Read an unquoted scalar value for KEY from the backend hcl file (empty if absent).
hcl_value() {
  sed -nE "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"?([^\"[:space:]]+)\"?.*/\1/p" "$BACKEND_FILE" | head -n1
}

# Create the S3 state bucket (from BACKEND_FILE) if it doesn't exist yet.
ensure_state_bucket() {
  [[ "${TF_SKIP_BOOTSTRAP:-}" == "1" ]] && return 0

  local bucket region existing
  bucket="$(hcl_value bucket)"
  # The backend region defaults to us-east-1 (see versions.tf); honor an
  # explicit region in the backend file if one is set.
  region="$(hcl_value region)"
  region="${region:-us-east-1}"

  if [[ -z "$bucket" ]]; then
    echo "No 'bucket' in $BACKEND_FILE; cannot bootstrap the state backend." >&2
    exit 1
  fi
  # S3 bucket names are lowercase; an unfilled placeholder (e.g.
  # tfstates-PROD-ACCOUNT-ID) contains illegal characters — fail clearly.
  if [[ "$bucket" =~ [^a-z0-9.-] ]]; then
    echo "State bucket '$bucket' in $BACKEND_FILE looks like an unfilled placeholder." >&2
    echo "Set a real, lowercase bucket name for '$ENV' before init." >&2
    exit 1
  fi

  # list-buckets is account-scoped, so this only matches a bucket we own.
  existing="$(aws s3api list-buckets --profile "$AWS_PROFILE" \
    --query "Buckets[?Name=='$bucket'].Name" --output text)" \
    || { echo "Failed to list S3 buckets (check AWS_PROFILE='$AWS_PROFILE')." >&2; exit 1; }
  [[ "$existing" == "$bucket" ]] && return 0

  echo "[$ENV] state bucket '$bucket' not found; creating in $region…" >&2
  if [[ "$region" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$bucket" --region "$region" \
      --profile "$AWS_PROFILE" >/dev/null
  else
    aws s3api create-bucket --bucket "$bucket" --region "$region" \
      --create-bucket-configuration "LocationConstraint=$region" \
      --profile "$AWS_PROFILE" >/dev/null
  fi
  aws s3api put-bucket-versioning --bucket "$bucket" --region "$region" \
    --profile "$AWS_PROFILE" --versioning-configuration Status=Enabled
  aws s3api put-bucket-encryption --bucket "$bucket" --region "$region" \
    --profile "$AWS_PROFILE" --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  aws s3api put-public-access-block --bucket "$bucket" --region "$region" \
    --profile "$AWS_PROFILE" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  echo "[$ENV] state bucket '$bucket' ready (versioned, encrypted, private)." >&2
}

run_init() {
  ensure_state_bucket
  terraform init \
    -backend-config="$BACKEND_FILE" \
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
