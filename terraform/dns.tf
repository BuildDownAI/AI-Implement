# Both a public and a private Route 53 zone for the domain already exist in the
# account. The private zone is associated with the orchestrator's VPC (split
# horizon), so the hostname must resolve from *inside* the VPC too — the A-alias
# is therefore written into both zones (see alb.tf). ACM's DNS validation is
# resolved over the public internet, so the validation records go in the public
# zone only.
data "aws_route53_zone" "public" {
  name         = local.env.domain
  private_zone = false
}

data "aws_route53_zone" "private" {
  name         = local.env.domain
  private_zone = true
  vpc_id       = local.env.vpc_id
}

resource "aws_acm_certificate" "orchestrator" {
  domain_name       = local.env.hostname
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "${local.name_prefix}-cert"
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.orchestrator.domain_validation_options :
    dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id         = data.aws_route53_zone.public.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "orchestrator" {
  certificate_arn         = aws_acm_certificate.orchestrator.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}
