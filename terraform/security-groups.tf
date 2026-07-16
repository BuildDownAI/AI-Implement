# ALB security group — public-facing
resource "aws_security_group" "alb" {
  name_prefix = "${local.name_prefix}-alb-"
  description = "ALB ingress from Internet, egress to orchestrator"
  vpc_id      = data.aws_vpc.main.id

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "${local.name_prefix}-alb"
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS from anywhere"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  description       = "HTTP from anywhere (redirected to HTTPS)"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_orchestrator" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.orchestrator.id
  from_port                    = 8080
  to_port                      = 8080
  ip_protocol                  = "tcp"
  description                  = "ALB to orchestrator on 8080"
}

# Orchestrator security group — private, only reachable from ALB
resource "aws_security_group" "orchestrator" {
  name_prefix = "${local.name_prefix}-orchestrator-"
  description = "Orchestrator instance: ingress from ALB only, all egress"
  vpc_id      = data.aws_vpc.main.id

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "${local.name_prefix}-orchestrator"
  }
}

resource "aws_vpc_security_group_ingress_rule" "orchestrator_from_alb" {
  security_group_id            = aws_security_group.orchestrator.id
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 8080
  to_port                      = 8080
  ip_protocol                  = "tcp"
  description                  = "Inbound from ALB on 8080"
}

resource "aws_vpc_security_group_egress_rule" "orchestrator_all" {
  security_group_id = aws_security_group.orchestrator.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "All outbound"
}
