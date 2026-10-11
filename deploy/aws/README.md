# Wardby on AWS (EKS) — Terraform module

This module creates the AWS infrastructure for a Wardby deployment on Amazon EKS:
a network, an EKS cluster with a system node group and a gVisor sandbox node
group, a private PostgreSQL database with password-less IAM login, container
registries, Secrets Manager secrets with the access the External Secrets
Operator needs, and the certificate, web application firewall and IAM role for
the public load balancer. It creates no Kubernetes objects and no load balancer
or DNS record for the hostname: those belong to the deployment manifests, which
read the values this module outputs.

Nothing about your account is hardcoded. Every identity (region, hostname,
account) is a variable or comes from the credentials Terraform runs with.

## What this creates

| File                                        | Creates                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.tf`                                   | Looks up the account, partition and DNS suffix from your credentials so no ARN is hardcoded.                                                                                                                                                                                                        |
| `vpc.tf`                                    | A VPC with public, private and database subnets across up to three zones, NAT gateway(s), and a database tier with no route out of the VPC. Skipped entirely with `existing_vpc_id`.                                                                                                                |
| `cluster.tf`                                | The EKS cluster (standard mode, access entries only), cluster-admin access entries, the Pod Identity agent, the VPC CNI with NetworkPolicy enforcement, kube-proxy, and the trust policy every workload role shares (Pod Identity, this cluster, this account).                                     |
| `nodegroups.tf`, `gvisor-install.sh`        | Two managed node groups on the EKS-optimized AL2023 AMI, with IMDSv2 required and a hop limit of 1. The sandbox group is tainted `sandbox=gvisor:NoSchedule` and labelled `wardby.dev/sandbox=gvisor`, and installs gVisor at boot. System nodes carry the only security group the database admits. |
| `rds.tf`                                    | A private, encrypted RDS for PostgreSQL instance in the database subnets. TLS is forced, IAM database authentication is on, the master password is generated and kept by RDS in Secrets Manager, and only system nodes can reach port 5432.                                                         |
| `database-iam.tf`                           | One IAM role per database workload (app, migrator, proxy, gateway), each bound to its Kubernetes service account through Pod Identity and allowed to log in as exactly one Postgres user.                                                                                                           |
| `ecr.tf`                                    | One ECR repository per Wardby image, with scan on push.                                                                                                                                                                                                                                             |
| `secrets.tf`                                | The Secrets Manager secrets the deployment needs, named `<name_prefix>/<id>`. Terraform never writes a value, so no secret passes through Terraform or its state.                                                                                                                                   |
| `eso.tf`                                    | The IAM role of the External Secrets Operator controller: read access to this module's secrets and nothing else.                                                                                                                                                                                    |
| `edge.tf`                                   | An ACM certificate for `hostname` (with Route 53 validation records when `route53_zone_id` is set) and a WAF web ACL for the load balancer: a per-IP rate limit, the AWS IP reputation list, and the AWS common and known-bad-inputs rule groups.                                                   |
| `lbc.tf`                                    | The IAM role and policy of the AWS Load Balancer Controller, bound to its service account through Pod Identity.                                                                                                                                                                                     |
| `variables.tf`, `outputs.tf`, `versions.tf` | Inputs, outputs and provider requirements. No backend is configured.                                                                                                                                                                                                                                |

## Prerequisites

- Terraform 1.10 or newer.
- AWS credentials that can create VPC, EKS, EC2, IAM, RDS, ECR, Secrets
  Manager, ACM and WAF resources (and Route 53 records if you set
  `route53_zone_id`). Whoever runs `terraform apply` becomes cluster admin.
- A hostname you control for the control plane.
- Network access from where Terraform runs to `raw.githubusercontent.com`.
  Terraform downloads the load balancer controller's IAM policy and checks its
  checksum on every plan, refresh and destroy, so it must be reachable each
  time, not only at the first apply.
- Outbound HTTPS from the private subnets for the sandbox nodes at boot: the
  AL2023 package repositories (the install script runs `dnf install bzip2` if
  the tool is missing) and the gVisor download, from `storage.googleapis.com`
  or your `gvisor_download_base_url` mirror.

## Quick start

```bash
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`: set at least `region`, `hostname` and
`public_access_cidrs` (your own address as a /32; `0.0.0.0/0` is refused).

```bash
terraform init
```

```bash
terraform apply
```

State is local by default. For shared use, configure a remote backend (for
example S3) in a git-ignored `backend.tf` or with `-backend-config`; the module
itself configures none.

Create the kubectl context from the `kubeconfig_command` output.

### The certificate and DNS

With `route53_zone_id` set, the module creates the certificate's validation
records and waits for issuance. Without it, the certificate stays pending: create
the DNS records listed in the `certificate_validation_records` output in your own
DNS. The certificate issues once they resolve, and the load balancer listener
cannot use it until then.

Changing `hostname` replaces the certificate. The old certificate stays attached
to the load balancer until the Gateway is moved to the new `certificate_arn`, so
deleting it fails until you have done that and applied again.

The DNS record for `hostname` itself points at the load balancer, which does not
exist until the Gateway is created, so the module does not manage it.

## Bring your own VPC

Set `existing_vpc_id` together with all three subnet lists, or none of them:

- `existing_public_subnet_ids`, `existing_private_subnet_ids` and
  `existing_database_subnet_ids`, at least two subnets each, in different
  availability zones.
- The private subnets need outbound internet (a NAT gateway) or VPC endpoints for
  ECR, EKS, STS and Secrets Manager, plus a path to the gVisor download.
- The database subnets must be reachable from the private subnets on port 5432.
  They may be the private subnets; isolated subnets are better.
- The module creates no network resources and tags none of your subnets. The
  load balancer is given `public_subnet_ids` explicitly, so subnet role tags
  are not required.

## gVisor on the sandbox nodes

Coding-run and native-worker pods run under gVisor on the sandbox node group.
At boot, `gvisor-install.sh` downloads the release named by `gvisor_version`
from `gvisor_download_base_url`, verifies it against `gvisor_sha512`, installs
`runsc` and the containerd shim, and registers the runtime with containerd under
the handler name `runsc`. The `gvisor` RuntimeClass in the manifests must use
handler `runsc`.

The install fails closed. Before anything that can fail, the script writes a
kubelet drop-in (`/etc/systemd/system/kubelet.service.d/00-wardby-gvisor.conf`)
requiring the file `/etc/wardby/gvisor-installed`, and it creates that file only
as the last step of a fully successful install. Until it exists, systemd does not
start kubelet, so the node never joins the cluster. This holds after a failed
download, a checksum mismatch, a killed or hung script, and across reboots. A
sandbox node that cannot install gVisor therefore shows up as a node-group
health issue (nodes failing to join) rather than as a node that could run
sandboxed pods without a sandbox.

To move to a new gVisor release:

1. Take the checksum from `<base>/<version>/x86_64/gvisor.tar.bz2.sha512` for the
   new release.
2. Set `gvisor_version` and `gvisor_sha512` together.
3. Apply, then replace the sandbox nodes (the node group rolls them when the
   launch template changes).

To avoid a boot-time dependency on the public bucket, copy the release files to
an HTTPS location you control (for example behind an S3 bucket) with the same
`<version>/x86_64/gvisor.tar.bz2` layout and set `gvisor_download_base_url`.
The checksum still applies.

Set `node_ami_release_version` to pin the AL2023 AMI release for both node groups
when a gVisor or containerd change needs a known-good pairing; leave it unset to
take the latest release for `kubernetes_version`.

## Security notes

- **Instance metadata.** IMDSv2 is required with a hop limit of 1, so pods cannot
  reach instance metadata. Add-ons that need the VPC id or region (such as the
  load balancer controller) must be given them explicitly.
- **Workload credentials** come only from EKS Pod Identity. Every role's trust is
  limited to this cluster and this account. Each database role may call
  `rds-db:connect` for exactly one Postgres user.
- **Database.** Not publicly accessible; encrypted at rest; `rds.force_ssl` forces
  TLS; the security group admits only system nodes, so run pods on sandbox nodes
  have no network path to Postgres. Terraform creates no Postgres users: the
  grants bootstrap creates them (see the `database_users` output) using the
  master password from `database_master_user_secret_arn`.
- **External Secrets.** With Pod Identity the operator reads secrets as its own
  controller identity, and a SecretStore cannot name another service account. Its
  role may read only this module's secrets, but every SecretStore in the cluster
  reads with it, so restrict who may create SecretStores with Kubernetes RBAC.
- **Web application firewall.** A per-IP rate limit (`waf_rate_limit` per
  `waf_rate_limit_window_seconds`, answered with 429) and the AWS IP reputation
  list block. The AWS common and known-bad-inputs rule groups follow
  `waf_managed_rules_action`, which starts at `count`: their body rules can match
  code in MCP tool arguments and large webhook payloads. Read the WAF logs for
  false positives before switching to `block`.
- **Load balancer controller policy.** The controller's IAM policy is downloaded at
  the pinned `lbc_version` and refused unless its SHA-256 equals
  `lbc_iam_policy_sha256`. Change `lbc_version`, the checksum and the controller's
  Helm chart together. The policy URL is the commercial-partition one.
- **Database engine upgrades.** `allow_major_version_upgrade` is on, so changing
  `database_engine_version` performs a major upgrade, applied in the maintenance
  window. Read RDS's major-version upgrade guidance and take a snapshot first.

## Inputs

Only `region` and `hostname` have no default, and `public_access_cidrs` is
required while `endpoint_public_access` is true.

| Variable                            | Default                                                  | Meaning                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `region`                            | required                                                 | AWS region for every resource.                                                                                                  |
| `name_prefix`                       | `wardby`                                                 | Prefix for every resource name and the cluster's name (3-20 characters).                                                        |
| `namespace`                         | `wardby-coding`                                          | Kubernetes namespace of the Wardby workloads; must match the manifests.                                                         |
| `tags`                              | `{}`                                                     | Extra tags added to every resource.                                                                                             |
| `vpc_cidr`                          | `10.40.0.0/16`                                           | CIDR of the VPC the module creates (/16 to /20). Ignored with `existing_vpc_id`.                                                |
| `single_nat_gateway`                | `true`                                                   | One NAT gateway for the VPC (cheaper) instead of one per zone. Ignored with `existing_vpc_id`.                                  |
| `existing_vpc_id`                   | `null`                                                   | Deploy into an existing VPC; set with all three subnet lists.                                                                   |
| `existing_public_subnet_ids`        | `[]`                                                     | With `existing_vpc_id`: subnets for the internet-facing load balancer.                                                          |
| `existing_private_subnet_ids`       | `[]`                                                     | With `existing_vpc_id`: subnets for nodes and pods.                                                                             |
| `existing_database_subnet_ids`      | `[]`                                                     | With `existing_vpc_id`: subnets for the RDS instance.                                                                           |
| `kubernetes_version`                | `1.36`                                                   | EKS Kubernetes minor version.                                                                                                   |
| `endpoint_public_access`            | `true`                                                   | Expose the Kubernetes API publicly, restricted to `public_access_cidrs`. With `false` it is reachable only from inside the VPC. |
| `public_access_cidrs`               | `[]`                                                     | CIDRs allowed to reach the public API endpoint; required while `endpoint_public_access` is true; `0.0.0.0/0` is refused.        |
| `additional_admin_principal_arns`   | `[]`                                                     | IAM principals given cluster-admin in addition to whoever applies.                                                              |
| `cluster_log_types`                 | `["api", "audit", "authenticator"]`                      | Control-plane log types sent to CloudWatch Logs.                                                                                |
| `upgrade_support_type`              | `STANDARD`                                               | `STANDARD` upgrades the control plane when standard support ends; `EXTENDED` stays on the version at the extended-support rate. |
| `cluster_deletion_protection`       | `true`                                                   | Guard against deleting the cluster. Apply `false` first, then destroy.                                                          |
| `node_ami_release_version`          | `null`                                                   | Pin the AL2023 AMI release for both node groups; `null` takes the latest.                                                       |
| `system_instance_types`             | `["m6i.large"]`                                          | Instance types of the system node group.                                                                                        |
| `system_min_size`                   | `2`                                                      | System node group minimum size.                                                                                                 |
| `system_desired_size`               | `2`                                                      | System node group initial size; later changes are ignored so manual scaling sticks.                                             |
| `system_max_size`                   | `4`                                                      | System node group maximum size.                                                                                                 |
| `system_disk_size_gb`               | `50`                                                     | Root volume of system nodes, GiB.                                                                                               |
| `sandbox_instance_types`            | `["m6i.xlarge"]`                                         | Instance types of the gVisor sandbox node group (x86_64 only).                                                                  |
| `sandbox_min_size`                  | `0`                                                      | Sandbox node group minimum size; 0 lets you scale it to nothing when idle.                                                      |
| `sandbox_desired_size`              | `1`                                                      | Sandbox node group initial size; later changes are ignored.                                                                     |
| `sandbox_max_size`                  | `3`                                                      | Sandbox node group maximum size.                                                                                                |
| `sandbox_disk_size_gb`              | `100`                                                    | Root volume of sandbox nodes, GiB.                                                                                              |
| `gvisor_version`                    | `20260921.0`                                             | gVisor release installed on sandbox nodes at boot.                                                                              |
| `gvisor_sha512`                     | the release's checksum                                   | SHA-512 of `gvisor.tar.bz2` for `gvisor_version` on x86_64. A node whose download does not match never joins.                   |
| `gvisor_download_base_url`          | `https://storage.googleapis.com/gvisor/releases/release` | Base URL of gVisor releases; point at your own HTTPS mirror to drop the dependency on Google's bucket.                          |
| `database_engine_version`           | `17`                                                     | RDS Postgres major version. Changing it performs a major upgrade.                                                               |
| `database_instance_class`           | `db.t4g.small`                                           | RDS instance class.                                                                                                             |
| `database_allocated_storage_gb`     | `20`                                                     | Initial storage, GiB.                                                                                                           |
| `database_max_allocated_storage_gb` | `100`                                                    | Storage autoscaling ceiling, GiB.                                                                                               |
| `database_multi_az`                 | `false`                                                  | Multi-AZ standby (roughly doubles the instance cost).                                                                           |
| `database_backup_retention_days`    | `7`                                                      | Automated backup retention, 1-35 days.                                                                                          |
| `database_name`                     | `wardby`                                                 | Database created inside the instance.                                                                                           |
| `database_master_username`          | `wardby`                                                 | RDS master user; used only to bootstrap the IAM database users and grants.                                                      |
| `database_deletion_protection`      | `true`                                                   | Guard against deleting the database. Apply `false` first, then destroy.                                                         |
| `ecr_force_delete`                  | `false`                                                  | Let destroy delete ECR repositories that still hold images.                                                                     |
| `secrets_recovery_window_days`      | `30`                                                     | Days a deleted secret can be restored (0 deletes at once, else 7-30).                                                           |
| `eso_namespace`                     | `external-secrets`                                       | Namespace of the External Secrets Operator controller.                                                                          |
| `eso_service_account`               | `external-secrets`                                       | Service account of the External Secrets Operator controller.                                                                    |
| `hostname`                          | required                                                 | Public hostname of the control plane; the certificate is issued for it.                                                         |
| `route53_zone_id`                   | `null`                                                   | Route 53 zone for `hostname`; when set, the module creates validation records and waits for issuance.                           |
| `waf_rate_limit`                    | `300`                                                    | Requests per client IP per window before the WAF answers 429 (minimum 10).                                                      |
| `waf_rate_limit_window_seconds`     | `60`                                                     | Rate-limit window: 60, 120, 300 or 600 seconds.                                                                                 |
| `waf_managed_rules_action`          | `count`                                                  | `count` logs matches of the AWS common and known-bad-inputs rule groups; `block` blocks them.                                   |
| `lbc_version`                       | `v3.5.0`                                                 | AWS Load Balancer Controller release whose IAM policy the role gets.                                                            |
| `lbc_iam_policy_sha256`             | the policy's checksum                                    | SHA-256 of that release's `iam_policy.json`; a mismatching download is refused.                                                 |
| `lbc_namespace`                     | `kube-system`                                            | Namespace of the load balancer controller.                                                                                      |
| `lbc_service_account`               | `aws-load-balancer-controller`                           | Service account of the load balancer controller.                                                                                |

## Outputs

| Output                            | Meaning                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `region`                          | The region.                                                                                       |
| `account_id`                      | The account the module was applied in.                                                            |
| `vpc_id`                          | The VPC (created, or `existing_vpc_id`); pass it to the load balancer controller explicitly.      |
| `public_subnet_ids`               | Subnets for the internet-facing load balancer.                                                    |
| `private_subnet_ids`              | Subnets of the nodes and pods.                                                                    |
| `database_subnet_cidrs`           | CIDRs of the database subnets, for the workloads' database egress NetworkPolicies.                |
| `cluster_name`                    | The EKS cluster name.                                                                             |
| `cluster_arn`                     | The EKS cluster ARN.                                                                              |
| `cluster_endpoint`                | The Kubernetes API endpoint.                                                                      |
| `cluster_security_group_id`       | The EKS-managed cluster security group, on every node.                                            |
| `kubeconfig_command`              | Command that creates the kubectl context for this cluster.                                        |
| `sandbox_node_selector`           | The `nodeSelector` the `gvisor` RuntimeClass's scheduling block must add.                         |
| `sandbox_toleration`              | The sandbox node taint (`key=value:effect`) the `gvisor` RuntimeClass must tolerate.              |
| `database_endpoint`               | RDS host name (the TLS server name for `sslmode=verify-full`).                                    |
| `database_port`                   | RDS port.                                                                                         |
| `database_name`                   | The database inside the instance.                                                                 |
| `database_resource_id`            | The instance's resource id (the instance part of `rds-db:connect` ARNs).                          |
| `database_master_username`        | The RDS master user.                                                                              |
| `database_master_user_secret_arn` | Secrets Manager secret holding the RDS-managed master password, for the one-off grants bootstrap. |
| `database_users`                  | The Postgres user per workload; the grants bootstrap creates them with `GRANT rds_iam`.           |
| `database_role_arns`              | The IAM role per database workload.                                                               |
| `ecr_registry`                    | Registry prefix for building images: images are `<ecr_registry>/<target>`.                        |
| `ecr_repository_urls`             | Repository URL per image.                                                                         |
| `secret_name_prefix`              | Secrets are named `<secret_name_prefix><id>`.                                                     |
| `secret_arns`                     | ARN per secret.                                                                                   |
| `external_secrets_role_arn`       | IAM role of the External Secrets Operator controller.                                             |
| `certificate_arn`                 | ACM certificate for `hostname`, for the load balancer's HTTPS listener.                           |
| `certificate_validation_records`  | DNS records that validate the certificate; create them yourself when `route53_zone_id` is unset.  |
| `waf_web_acl_arn`                 | WAF web ACL for the load balancer.                                                                |
| `lbc_role_arn`                    | IAM role of the AWS Load Balancer Controller.                                                     |

## Cost

While it exists, this module bills for: the EKS control plane (hourly), NAT
gateway(s) (hourly plus data processed), EC2 nodes for both groups, the RDS
instance, its storage and backups, WAF (per web ACL, rule and request), Secrets
Manager (per secret), CloudWatch Logs for the control-plane log types. ACM
certificates are free. The load balancer created later from the Gateway bills
separately. When idle, scale the sandbox node group to 0 (`sandbox_min_size` is
0 by default); the system group and the database keep running.

## Teardown

1. Delete the Kubernetes Gateway first, and wait for the controller to remove the
   load balancer. A load balancer left behind blocks deleting the VPC.
2. Set `cluster_deletion_protection = false` and
   `database_deletion_protection = false` and apply.
3. Run `terraform destroy`.

Things that bite on teardown and rebuild:

- The final database snapshot is named `<name_prefix>-final`, a fixed name. It is
  kept after destroy; delete it before destroying a recreated instance, or the
  destroy fails.
- Secrets enter a recovery window of `secrets_recovery_window_days`. Applying
  again with the same `name_prefix` inside the window fails with a "scheduled for
  deletion" error: restore each secret with `aws secretsmanager restore-secret`,
  or import it. This is deliberate: losing `secret-app-key` makes every stored
  credential unreadable.
- ECR repositories that still hold images need `ecr_force_delete = true`
  (applied before the destroy).
- Replacing the certificate (see "The certificate and DNS") can fail to delete the
  old one while a load balancer still uses it.

## Checking changes to this module

```bash
terraform fmt -check -recursive
```

```bash
terraform init -backend=false
```

```bash
terraform validate
```

```bash
terraform test
```

`terraform test` uses mock providers: no AWS account or credentials are needed.

```bash
npx vitest run deploy/aws
```
