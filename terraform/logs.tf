resource "aws_cloudwatch_log_group" "orchestrator" {
  name              = "/${var.project}/orchestrator"
  retention_in_days = var.log_retention_days

  tags = {
    Name = "${local.name_prefix}-orchestrator-logs"
  }
}

resource "aws_sns_topic" "alerts" {
  name = "${local.name_prefix}-alerts"

  tags = {
    Name = "${local.name_prefix}-alerts"
  }
}

# NAT egress is provided by the pre-existing VPC's managed NAT gateways, which
# are owned/monitored outside this stack — so there is no NAT status alarm here
# (the fck-nat instance and its alarm were removed with the archive's nat.tf).
