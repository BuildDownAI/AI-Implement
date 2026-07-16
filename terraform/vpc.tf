# Networking is reused from a pre-existing VPC in the target account (see
# locals.tf). This stack creates no VPC, subnets, internet gateway, NAT, or
# route tables — it only looks up what it needs. The chosen private subnet
# already routes 0.0.0.0/0 through a managed NAT gateway for egress.

data "aws_vpc" "main" {
  id = local.env.vpc_id
}

# The single private subnet the orchestrator instance runs in. Exposes
# `.availability_zone`, which pins the AZ-locked EBS data volume (ec2.tf).
data "aws_subnet" "orchestrator" {
  id = local.env.orchestrator_subnet_id
}

locals {
  # Public subnets for the internet-facing ALB (must span >= 2 AZs).
  public_subnet_ids = local.env.public_subnet_ids
}
