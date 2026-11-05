---
'@salza80/openclaw-aws': patch
---

Install OpenClaw 2026.11.1 using the pinned official private-prefix installer with Node.js 24.22.2. Remove unconditional NVM, Homebrew, GCC, and Docker setup, and preserve API-provider compatibility through native environment secret references.

Wait for authenticated Gateway health and CloudFormation readiness signals, then confirm SSM access before deployment succeeds. Bound runtime SSM parameter reads to the deployment's secrets, retain optional CloudWatch logging, and support required Cloudflare Gateway metadata. Existing deployed instances are not upgraded or replaced by updating the CLI.

Preserve failed fresh deployments and bounded private diagnostics for investigation, with explicit cleanup guidance. Keep legacy Cloudflare configurations usable for lifecycle commands and deletion without requiring new-instance metadata.
