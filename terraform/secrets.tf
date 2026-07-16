# RUNNER_CALLBACK_BASE_URL is intentionally absent from ssm_secrets: it is a
# non-secret String parameter that Terraform owns end-to-end (derived from
# local.env.hostname) and is declared separately as aws_ssm_parameter.runner_callback_base_url
# below. Including it here would create a duplicate SecureString placeholder.
locals {
  # meq uses Jira for issue tracking, so LINEAR_API_KEY stays disabled and the
  # JIRA_* params are the active ticketing config.
  ssm_secrets = [
    #    "LINEAR_API_KEY",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
    # Jira Basic auth (recommended): JIRA_EMAIL + JIRA_TOKEN (API token) +
    # JIRA_SITE_URL. JIRA_CLOUD_ID is only needed for the OAuth Bearer path.
    "JIRA_EMAIL",
    "JIRA_TOKEN",
    "JIRA_CLOUD_ID",
    "JIRA_SITE_URL",
    "ADMIN_ACCESS_CODE",
    "RUNNER_TOKEN_SECRET",
    "GAP_FILL_TRIGGER_SECRET",
    "NOTIFY_TYPE",
    "NOTIFY_WEBHOOK_URL",
  ]
}

resource "aws_ssm_parameter" "secret" {
  for_each = toset(local.ssm_secrets)

  name        = "/${var.project}/${each.key}"
  description = "Set manually after first apply via 'aws ssm put-parameter --overwrite'"
  type        = "SecureString"
  value       = "REPLACE_ME"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Name = "${local.name_prefix}-${each.key}"
  }
}

# Non-secret config parameters Terraform owns end-to-end
resource "aws_ssm_parameter" "runner_callback_base_url" {
  name  = "/${var.project}/RUNNER_CALLBACK_BASE_URL"
  type  = "String"
  value = "https://${local.env.hostname}"

  tags = {
    Name = "${local.name_prefix}-RUNNER_CALLBACK_BASE_URL"
  }
}

# Runner image for session machines, injected as the SESSION_IMAGE container
# env var. Owning it here keeps the org-specific value out of upstream-owned
# src/index.ts (whose built-in default stays generic), so the fork merges
# upstream cleanly. Per-env value comes from local.env.session_image.
resource "aws_ssm_parameter" "session_image" {
  name  = "/${var.project}/SESSION_IMAGE"
  type  = "String"
  value = local.env.session_image

  tags = {
    Name = "${local.name_prefix}-SESSION_IMAGE"
  }
}

# Global runner-mode override. On this EC2 host there are no Fly session
# credentials, so pin every dispatch to the github-actions path — `gha` makes
# the orchestrator ignore any per-mapping fly-machines execution mode and never
# attempt a Fly dispatch. Injected as the RUNNER_MODE container env var.
resource "aws_ssm_parameter" "runner_mode" {
  name  = "/${var.project}/RUNNER_MODE"
  type  = "String"
  value = "gha"

  tags = {
    Name = "${local.name_prefix}-RUNNER_MODE"
  }
}

# Environment name injected as AI_IMPLEMENT_ENV so the admin UI version card
# can display dev/prod without a user-data change.
resource "aws_ssm_parameter" "environment_name" {
  name  = "/${var.project}/AI_IMPLEMENT_ENV"
  type  = "String"
  value = var.environment

  tags = {
    Name = "${local.name_prefix}-AI_IMPLEMENT_ENV"
  }
}

# Pointer to the currently-deployed orchestrator image. Lives on a separate
# SSM path (/${var.project}-deploy/...) so it is *not* picked up by
# run-orchestrator.sh's recursive get-parameters-by-path of /${var.project}/
# and accidentally injected as a container env var.
#
# The deploy workflow overwrites this on every successful build via
# `aws ssm put-parameter --overwrite`. Terraform seeds a placeholder on first
# apply and ignores subsequent value changes.
resource "aws_ssm_parameter" "current_image" {
  name        = "/${var.project}-deploy/current-image"
  description = "Full image reference (registry/repo:sha) of the currently-deployed orchestrator. Updated by the deploy workflow."
  type        = "String"
  value       = "${aws_ecr_repository.orchestrator.repository_url}:bootstrap-pending"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Name = "${local.name_prefix}-current-image"
  }
}
