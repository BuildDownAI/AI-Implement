#Requires -Version 5.1
<#
.SYNOPSIS
  Environment-aware terraform wrapper.

.DESCRIPTION
  The environment is the only parameter besides the AWS profile - it selects
  both the state location (envs/<env>.backend.hcl) and the per-env values
  (locals.tf env_config).

  Each environment keeps its own working directory (.terraform-<env>) so
  switching between dev and prod never reuses the other's cached backend.
  Commands other than init auto-init first if the env was never initialized.

.EXAMPLE
  $env:AWS_PROFILE = 'my-profile'; .\tf.ps1 dev init
  $env:AWS_PROFILE = 'my-profile'; .\tf.ps1 dev plan
  $env:AWS_PROFILE = 'my-profile'; .\tf.ps1 prod apply
  $env:AWS_PROFILE = 'my-profile'; .\tf.ps1 dev output -raw route53_zone_id
#>
param(
  [Parameter(Position = 0, Mandatory)]
  [ValidateSet('dev', 'prod')]
  [string]$Env,

  [Parameter(Position = 1, Mandatory)]
  [string]$Command,

  [Parameter(Position = 2, ValueFromRemainingArguments)]
  [string[]]$Rest
)

if (-not $env:AWS_PROFILE) {
  Write-Error "Set `$env:AWS_PROFILE to the AWS CLI profile for the $Env account."
  exit 1
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$env:TF_DATA_DIR = ".terraform-$Env"

$BackendFile = "envs/$Env.backend.hcl"

function Get-HclValue {
  param([string]$Key)
  $line = Select-String -Path $BackendFile -Pattern "^\s*$Key\s*=" | Select-Object -First 1
  if (-not $line) { return "" }
  if ($line.Line -match "^\s*$Key\s*=\s*`"?([^`"\s]+)`"?") { return $Matches[1] }
  return ""
}

# Create the S3 state bucket (from $BackendFile) if it doesn't exist yet.
# Idempotent; set $env:TF_SKIP_BOOTSTRAP='1' to skip.
function Initialize-StateBucket {
  if ($env:TF_SKIP_BOOTSTRAP -eq '1') { return }

  $bucket = Get-HclValue 'bucket'
  $region = Get-HclValue 'region'
  if (-not $region) { $region = 'us-east-1' }  # backend default (versions.tf)

  if (-not $bucket) {
    Write-Error "No 'bucket' in $BackendFile; cannot bootstrap the state backend."
    exit 1
  }
  if ($bucket -cmatch '[^a-z0-9.-]') {
    Write-Error "State bucket '$bucket' in $BackendFile looks like an unfilled placeholder. Set a real, lowercase bucket name for '$Env' before init."
    exit 1
  }

  $existing = aws s3api list-buckets --profile $env:AWS_PROFILE `
    --query "Buckets[?Name=='$bucket'].Name" --output text
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to list S3 buckets (check `$env:AWS_PROFILE='$env:AWS_PROFILE')."
    exit 1
  }
  if ($existing -eq $bucket) { return }

  Write-Host "[$Env] state bucket '$bucket' not found; creating in $region..." -ForegroundColor DarkGray
  if ($region -eq 'us-east-1') {
    aws s3api create-bucket --bucket $bucket --region $region --profile $env:AWS_PROFILE | Out-Null
  } else {
    aws s3api create-bucket --bucket $bucket --region $region `
      --create-bucket-configuration "LocationConstraint=$region" --profile $env:AWS_PROFILE | Out-Null
  }
  aws s3api put-bucket-versioning --bucket $bucket --region $region `
    --profile $env:AWS_PROFILE --versioning-configuration Status=Enabled
  aws s3api put-bucket-encryption --bucket $bucket --region $region `
    --profile $env:AWS_PROFILE --server-side-encryption-configuration `
    '{\"Rules\":[{\"ApplyServerSideEncryptionByDefault\":{\"SSEAlgorithm\":\"AES256\"}}]}'
  aws s3api put-public-access-block --bucket $bucket --region $region `
    --profile $env:AWS_PROFILE --public-access-block-configuration `
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
  Write-Host "[$Env] state bucket '$bucket' ready (versioned, encrypted, private)." -ForegroundColor DarkGray
}

function Invoke-Init {
  param([string[]]$ExtraArgs)
  Initialize-StateBucket
  & terraform init `
    "-backend-config=$BackendFile" `
    "-backend-config=profile=$env:AWS_PROFILE" `
    @ExtraArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if ($Command -eq 'init') {
  Invoke-Init -ExtraArgs $Rest
  exit $LASTEXITCODE
}

# Auto-init on first use of this environment.
if (-not (Test-Path "$env:TF_DATA_DIR\terraform.tfstate")) {
  Write-Host "[$Env] not initialized yet; running terraform init" -ForegroundColor DarkGray
  Invoke-Init
}

# Only commands that evaluate the configuration accept -var.
$varCommands = @('plan', 'apply', 'destroy', 'refresh', 'import', 'console')
if ($varCommands -contains $Command) {
  & terraform $Command `
    "-var=environment=$Env" `
    "-var=aws_profile=$env:AWS_PROFILE" `
    @Rest
} else {
  & terraform $Command @Rest
}

exit $LASTEXITCODE
