variable "environment" {
  description = "Target environment; selects per-env settings in locals.tf and must match the envs/<env>.backend.hcl used at init"
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be \"dev\" or \"prod\"."
  }
}

variable "aws_profile" {
  description = "Local AWS CLI profile to use"
  type        = string
}

variable "project" {
  description = "Project name; used as a prefix and tag"
  type        = string
  default     = "ai-implement"
}

variable "instance_type" {
  description = "EC2 instance type for the orchestrator"
  type        = string
  default     = "t4g.nano"
}

variable "data_volume_size_gb" {
  description = "Size of the persistent EBS volume mounted at /data"
  type        = number
  default     = 20
}

variable "github_repo" {
  description = "owner/repo (exact case) allowed to assume the deploy role via GitHub OIDC"
  type        = string
  default     = "meQuilibrium/AI-Implement"
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the orchestrator log group"
  type        = number
  default     = 30
}

variable "alb_log_retention_days" {
  description = "S3 lifecycle expiration for ALB access logs"
  type        = number
  default     = 30
}
