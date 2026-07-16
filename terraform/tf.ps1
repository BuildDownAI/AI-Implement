#Requires -Version 5.1
<#
.SYNOPSIS
  Environment-aware terraform wrapper.

.DESCRIPTION
  The environment is the only parameter besides the AWS profile — it selects
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

function Invoke-Init {
  param([string[]]$ExtraArgs)
  & terraform init `
    "-backend-config=envs/$Env.backend.hcl" `
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
