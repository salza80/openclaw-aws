---
'@salza80/openclaw-aws': patch
---

Update dependencies and development tooling. Require Node.js 22.13+ for the local CLI and use Node.js 24.22.2 with OpenClaw 2026.10.9 for new AWS deployments.

Configure the gateway token before installing its service, and stop bootstrap on missing secrets or failed onboarding rather than reporting a successful setup.
