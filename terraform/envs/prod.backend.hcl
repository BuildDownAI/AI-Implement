# State location for the prod environment.
# TODO(prod): prod is not configured for the meq deployment. Point `bucket` at
# the state bucket created (per the README's "Create the state bucket" step) in
# whichever account hosts prod, and fill in the prod values in locals.tf.
# `profile` is intentionally absent — tf.sh passes it from AWS_PROFILE at init.
bucket = "tfstates-PROD-ACCOUNT-ID"
key    = "mymeq-prod/ai-implement/terraform.tfstate"
