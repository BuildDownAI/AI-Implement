terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.43"
    }
  }

  # bucket and key come from envs/<env>.backend.hcl; profile is passed at
  # init time. Always init through ./tf.sh, which wires both up.
  #
  # `region` here is where the tfstate *bucket* lives, independent of the
  # region the stack deploys resources into (that's per-env in locals.tf).
  # Both state buckets are in us-east-1 today; if a future env's state bucket
  # lives elsewhere, add `region = ...` to that env's backend.hcl to override.
  backend "s3" {
    region       = "us-east-1"
    use_lockfile = true
    encrypt      = true
  }
}
