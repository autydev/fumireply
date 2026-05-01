###############################################################################
# Remote state backend.
#
# Bucket / lock table / KMS key are provisioned by terraform/bootstrap (one-off
# local-state apply). Any change to those names must be mirrored here.
###############################################################################

terraform {
  backend "s3" {
    bucket       = "malbek-terraform-state"
    key          = "envs/review/terraform.tfstate"
    region       = "ap-northeast-1"
    use_lockfile = true
    encrypt      = true
    kms_key_id   = "alias/terraform-state"
  }
}
