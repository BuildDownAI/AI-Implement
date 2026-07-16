locals {
  # Per-environment settings.
  #
  # Networking is *reused* from a pre-existing VPC in the target account rather
  # than created by this stack — `vpc_id`, `public_subnet_ids` (ALB, multi-AZ)
  # and `orchestrator_subnet_id` (the single AZ the EC2 instance + its AZ-locked
  # EBS volume live in) are all looked up as data sources (see vpc.tf). The
  # chosen private subnet already routes egress through a managed NAT gateway,
  # so there is no fck-nat instance in this stack.
  #
  # DNS: both a public and a private Route 53 zone for `domain` already exist in
  # the account (the private one associated with `vpc_id` — split horizon), so
  # dns.tf looks both up and writes the hostname A-alias into each.
  #
  # `session_image` is the runner image the orchestrator boots session machines
  # on. It is injected as the SESSION_IMAGE container env var (see secrets.tf /
  # run-orchestrator.sh) so the upstream-owned source default in src/index.ts
  # stays generic and never has to be patched in this fork. Channel pairing must
  # match the branch the orchestrator deploys from (deploy-aws.yml): dev runs
  # `testing` code so it tracks `:next`; prod runs `main` code so it tracks the
  # stable `:latest`.
  #
  # `region` is the AWS region the stack deploys into. The EC2 AMI is a
  # region-aware data lookup (data.aws_ami.al2023_arm), so it resolves the
  # correct AL2023 image for whichever region is set here — no per-env AMI id.
  env_config = {
    dev = {
      domain        = "meqdev.com"
      hostname      = "ai-implement.meqdev.com"
      session_image = "ghcr.io/builddownai/ai-implement-runner:next"
      region        = "us-east-1"
      vpc_id        = "vpc-0ce82806e24a72d62"
      public_subnet_ids = [
        "subnet-093966750b59ebcef", # Public Subnet One   (us-east-1a)
        "subnet-0a75989d18ac1857a", # Public Subnet Two   (us-east-1b)
        "subnet-0e58e215a2ef102f0", # Public Subnet Three (us-east-1c)
      ]
      orchestrator_subnet_id = "subnet-0e22f46656c3af775" # Private Subnet One (us-east-1a)
    }
    prod = {
      # TODO(prod): prod is not configured for the meq deployment. Fill in the
      # domain/hostname, the pre-existing VPC + subnet ids for the prod account,
      # the region, and the `:latest` runner image before the first prod apply
      # (and set envs/prod.backend.hcl to the prod state bucket).
      domain                 = "meqdev.com"
      hostname               = "ai-implement.meqdev.com"
      session_image          = "ghcr.io/builddownai/ai-implement-runner:latest"
      region                 = "us-east-1"
      vpc_id                 = "vpc-0ce82806e24a72d62"
      public_subnet_ids      = []
      orchestrator_subnet_id = ""
    }
  }

  env = local.env_config[var.environment]

  account_id = data.aws_caller_identity.current.account_id

  common_tags = {
    Project     = var.project
    ManagedBy   = "terraform"
    Environment = var.environment
  }

  name_prefix = var.project
}
