data "aws_ami" "al2023_arm" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    # Match the standard AL2023 AMI ("al2023-ami-2023.X…-arm64"). The
    # 2023* glob avoids the minimal variant ("al2023-ami-minimal-2023…")
    # which omits amazon-ssm-agent and other useful tooling.
    name   = "name"
    values = ["al2023-ami-2023*-arm64"]
  }
  filter {
    name   = "architecture"
    values = ["arm64"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_ebs_volume" "data" {
  availability_zone = data.aws_subnet.orchestrator.availability_zone
  size              = var.data_volume_size_gb
  type              = "gp3"
  encrypted         = true

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name = "${local.name_prefix}-data"
  }
}

locals {
  run_script = templatefile("${path.module}/templates/run-orchestrator.sh.tftpl", {
    region    = local.env.region
    project   = var.project
    log_group = aws_cloudwatch_log_group.orchestrator.name
  })

  systemd_unit = file("${path.module}/templates/orchestrator.service.tftpl")

  user_data = templatefile("${path.module}/templates/user-data.sh.tftpl", {
    run_script   = local.run_script
    systemd_unit = local.systemd_unit
  })
}

resource "aws_instance" "orchestrator" {
  ami                    = data.aws_ami.al2023_arm.id
  instance_type          = var.instance_type
  subnet_id              = local.env.orchestrator_subnet_id
  vpc_security_group_ids = [aws_security_group.orchestrator.id]
  iam_instance_profile   = aws_iam_instance_profile.orchestrator.name

  user_data                   = local.user_data
  user_data_replace_on_change = true

  root_block_device {
    volume_size = 8
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }

  lifecycle {
    # The AMI is a most_recent data lookup, so a newer AL2023 release from
    # Amazon would otherwise force-replace this running instance on the next
    # apply. Pin the live instance to the AMI it launched on; a fresh instance
    # (intentional replace) still gets the current AMI from the data source.
    # To adopt a newer AMI deliberately:
    #   terraform apply -replace=aws_instance.orchestrator
    # The /data EBS volume is a separate prevent_destroy resource, so its data
    # survives a replacement.
    ignore_changes = [ami]
  }

  tags = {
    Name    = "${local.name_prefix}-orchestrator"
    Project = var.project
  }

  depends_on = [
    aws_iam_role_policy.orchestrator_inline,
  ]
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.orchestrator.id

  # Detach volume on instance replacement instead of failing
  stop_instance_before_detaching = true
}

resource "aws_lb_target_group_attachment" "orchestrator" {
  target_group_arn = aws_lb_target_group.orchestrator.arn
  target_id        = aws_instance.orchestrator.id
  port             = 8080
}

resource "aws_cloudwatch_metric_alarm" "healthy_hosts" {
  alarm_name          = "${local.name_prefix}-healthy-hosts"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Average"
  threshold           = 1
  alarm_description   = "Orchestrator target group has no healthy targets"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    TargetGroup  = aws_lb_target_group.orchestrator.arn_suffix
    LoadBalancer = aws_lb.main.arn_suffix
  }
}
