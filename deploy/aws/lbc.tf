# IAM role for the AWS Load Balancer Controller (installed by the deployment
# script), bound to its service account through Pod Identity.
#
# Its policy is the controller project's published IAM policy for lbc_version,
# fetched at plan time and refused unless its SHA-256 matches
# lbc_iam_policy_sha256: pinned like a dependency rather than copied into this
# repository. It is the commercial-partition policy; other partitions publish
# their own file.

data "http" "lbc_iam_policy" {
  url = "https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/${var.lbc_version}/docs/install/iam_policy.json"

  lifecycle {
    postcondition {
      condition     = self.status_code == 200 && sha256(self.response_body) == var.lbc_iam_policy_sha256
      error_message = "The downloaded load balancer controller IAM policy does not match lbc_iam_policy_sha256. Check lbc_version and the checksum together."
    }
  }
}

resource "aws_iam_policy" "lbc" {
  name   = "${var.name_prefix}-aws-load-balancer-controller"
  policy = data.http.lbc_iam_policy.response_body
}

resource "aws_iam_role" "lbc" {
  name               = "${var.name_prefix}-lbc"
  assume_role_policy = local.pod_identity_trust_policy
}

resource "aws_iam_role_policy_attachment" "lbc" {
  role       = aws_iam_role.lbc.name
  policy_arn = aws_iam_policy.lbc.arn
}

resource "aws_eks_pod_identity_association" "lbc" {
  cluster_name    = aws_eks_cluster.main.name
  namespace       = var.lbc_namespace
  service_account = var.lbc_service_account
  role_arn        = aws_iam_role.lbc.arn

  depends_on = [aws_eks_addon.pod_identity_agent]
}
