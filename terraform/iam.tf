# ---------- Orchestrator instance role ----------

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "orchestrator" {
  name               = "${local.name_prefix}-orchestrator"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "orchestrator_ssm_managed" {
  role       = aws_iam_role.orchestrator.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "orchestrator_inline" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrPull"
    actions = [
      "ecr:BatchGetImage",
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.orchestrator.arn]
  }
  statement {
    sid = "SsmRead"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]
    resources = [
      # GetParametersByPath authorizes against the path itself, not children.
      # Include both forms so per-parameter Get* and recursive list both work.
      "arn:aws:ssm:${local.env.region}:${local.account_id}:parameter/${var.project}",
      "arn:aws:ssm:${local.env.region}:${local.account_id}:parameter/${var.project}/*",
      # Deploy-metadata path (current-image pointer). Separate prefix keeps it
      # out of the recursive env-var bundle that run-orchestrator.sh fetches.
      "arn:aws:ssm:${local.env.region}:${local.account_id}:parameter/${var.project}-deploy/*",
    ]
  }
  statement {
    sid       = "KmsDecryptForSsm"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${local.env.region}.amazonaws.com"]
    }
  }
  statement {
    sid = "CloudWatchLogsWrite"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.orchestrator.arn}:*"]
  }
}

resource "aws_iam_role_policy" "orchestrator_inline" {
  name   = "${local.name_prefix}-orchestrator-inline"
  role   = aws_iam_role.orchestrator.id
  policy = data.aws_iam_policy_document.orchestrator_inline.json
}

resource "aws_iam_instance_profile" "orchestrator" {
  name = "${local.name_prefix}-orchestrator"
  role = aws_iam_role.orchestrator.name
}

# ---------- GitHub OIDC deploy role ----------

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      # GitHub sets the sub claim to the environment name when a job targets
      # a GitHub Environment — the branch-based form is not sent in that case.
      values = [
        "repo:${var.github_repo}:environment:${var.environment}",
      ]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = "${local.name_prefix}-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_assume.json
}

data "aws_iam_policy_document" "deploy_inline" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrPushPull"
    actions = [
      "ecr:BatchGetImage",
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
    ]
    resources = [aws_ecr_repository.orchestrator.arn]
  }
  statement {
    sid       = "Ec2Describe"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }

  statement {
    sid       = "SsmSendDocument"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:aws:ssm:${local.env.region}::document/AWS-RunShellScript"]
  }

  statement {
    sid       = "SsmSendToTaggedInstances"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:aws:ec2:${local.env.region}:${local.account_id}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "ssm:resourceTag/Project"
      values   = [var.project]
    }
  }
  statement {
    sid = "SsmPoll"
    actions = [
      "ssm:GetCommandInvocation",
      "ssm:ListCommandInvocations",
    ]
    resources = ["*"]
  }

  statement {
    sid     = "SsmPutCurrentImage"
    actions = ["ssm:PutParameter"]
    resources = [
      "arn:aws:ssm:${local.env.region}:${local.account_id}:parameter/${var.project}-deploy/current-image",
    ]
  }
}

resource "aws_iam_role_policy" "deploy_inline" {
  name   = "${local.name_prefix}-deploy-inline"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy_inline.json
}
