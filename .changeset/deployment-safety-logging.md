---
'@salza80/openclaw-aws': patch
---

Preserve secrets and configs when a stack lookup fails, and restore the caller's AWS profile between configs in batch operations.

Implement optional CloudWatch collection of bootstrap and gateway logs with scoped permissions and 30-day retention for new deployments. Update globals while keeping TypeScript on version 6.
