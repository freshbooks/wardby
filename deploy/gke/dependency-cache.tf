# Run dependency cache: a private bucket the coding proxy -- and nothing else --
# can read and write. Off unless dependency_cache_enabled = true; with it off
# this file creates nothing and existing plans do not change.
#
# The proxy is the only component that touches the blob store: workers upload
# and download through it. Access is granted to the proxy's Google service
# account (database-iam.tf, bound to the proxy's Kubernetes service account via
# Workload Identity) on this bucket only. The control plane, the migrator, the
# native gateway and every worker pod get no access to it.

resource "google_storage_bucket" "dependency_cache" {
  count = var.dependency_cache_enabled ? 1 : 0

  project  = var.project_id
  name     = var.dependency_cache_bucket_name
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  # Snapshots are deleted by the proxy when they expire or are evicted. An
  # upload that crashed before its database row was written leaves an orphan
  # nothing will ever delete, so this age rule is the backstop: a week past the
  # longest a snapshot may live.
  lifecycle_rule {
    condition {
      age = var.dependency_cache_max_age_days + 7
    }
    action {
      type = "Delete"
    }
  }

  lifecycle {
    precondition {
      condition     = var.dependency_cache_bucket_name != ""
      error_message = "dependency_cache_bucket_name is required when dependency_cache_enabled is true."
    }
  }
}

# objectAdmin (read, write, delete objects), on this bucket, for the proxy's
# service account only. A bucket-level member, not a project-level role.
resource "google_storage_bucket_iam_member" "dependency_cache_proxy" {
  count = var.dependency_cache_enabled ? 1 : 0

  bucket = google_storage_bucket.dependency_cache[0].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.database["proxy"].email}"
}
