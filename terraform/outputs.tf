output "alb_dns_name" {
  description = "DNS name of the public ALB"
  value       = aws_lb.main.dns_name
}

output "hostname_url" {
  description = "Public URL the orchestrator is reachable at"
  value       = "https://${local.env.hostname}"
}

output "ecr_repository_url" {
  description = "ECR repository URL for the orchestrator image"
  value       = aws_ecr_repository.orchestrator.repository_url
}

output "instance_id" {
  description = "EC2 instance ID for the orchestrator"
  value       = aws_instance.orchestrator.id
}

output "deploy_role_arn" {
  description = "GitHub Actions OIDC deploy role ARN"
  value       = aws_iam_role.deploy.arn
}

output "log_group_name" {
  description = "CloudWatch log group for orchestrator stdout/stderr"
  value       = aws_cloudwatch_log_group.orchestrator.name
}

output "alerts_topic_arn" {
  description = "SNS topic for alerts (subscribe an email to receive)"
  value       = aws_sns_topic.alerts.arn
}

output "route53_public_zone_id" {
  description = "Public Route53 hosted zone ID for the domain"
  value       = data.aws_route53_zone.public.zone_id
}

output "route53_private_zone_id" {
  description = "Private (VPC-associated) Route53 hosted zone ID for the domain"
  value       = data.aws_route53_zone.private.zone_id
}
