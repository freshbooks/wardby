# Run dependency cache: a private bucket the coding proxy -- and nothing else --
# can read and write. Off unless dependency_cache_enabled = true; with it off
# this file creates nothing and existing plans do not change.
#
# The proxy is the only component that touches the blob store: workers upload
# and download through it. Access is a policy on the proxy's Pod Identity role
# (database-iam.tf) scoped to this one bucket. The control plane, migrator,
# native gateway and every worker pod get no access to it.

resource "aws_s3_bucket" "dependency_cache" {
  count = var.dependency_cache_enabled ? 1 : 0

  bucket        = var.dependency_cache_bucket_name
  force_destroy = false

  lifecycle {
    precondition {
      condition     = var.dependency_cache_bucket_name != ""
      error_message = "dependency_cache_bucket_name is required when dependency_cache_enabled is true."
    }
  }
}

resource "aws_s3_bucket_public_access_block" "dependency_cache" {
  count = var.dependency_cache_enabled ? 1 : 0

  bucket                  = aws_s3_bucket.dependency_cache[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "dependency_cache" {
  count = var.dependency_cache_enabled ? 1 : 0

  bucket = aws_s3_bucket.dependency_cache[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "dependency_cache" {
  count = var.dependency_cache_enabled ? 1 : 0

  bucket = aws_s3_bucket.dependency_cache[0].id

  # Snapshots are deleted by the proxy when they expire or are evicted. An
  # upload that crashed before its database row was written leaves an orphan
  # nothing will ever delete, so this age rule is the backstop: a week past the
  # longest a snapshot may live.
  rule {
    id     = "expire-orphaned-snapshots"
    status = "Enabled"
    filter {}
    expiration {
      days = var.dependency_cache_max_age_days + 7
    }
  }

  # Uploads over the multipart threshold that never completed keep their parts
  # (and bill for them) until aborted.
  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_policy" "dependency_cache" {
  count = var.dependency_cache_enabled ? 1 : 0

  bucket = aws_s3_bucket.dependency_cache[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.dependency_cache[0].arn, "${aws_s3_bucket.dependency_cache[0].arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.dependency_cache]
}

# What the S3 blob adapter calls: GetObject (read and HEAD), PutObject (single
# and multipart parts), DeleteObject, and the multipart bookkeeping calls. A HEAD
# on a missing key answers 403 instead of 404 without s3:ListBucket, so the
# adapter could not tell "not there" from "not allowed".
resource "aws_iam_role_policy" "dependency_cache_proxy" {
  count = var.dependency_cache_enabled ? 1 : 0

  name = "dependency-cache-bucket"
  role = aws_iam_role.database["proxy"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "Objects"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts",
        ]
        Resource = "${aws_s3_bucket.dependency_cache[0].arn}/*"
      },
      {
        Sid      = "ListBucket"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.dependency_cache[0].arn
      },
    ]
  })
}
