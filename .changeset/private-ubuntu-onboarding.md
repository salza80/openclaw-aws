---
'@salza80/openclaw-aws': patch
---

Set the native bootstrap umask after switching to Ubuntu so sudo/PAM cannot create group-writable workspace and agent parents that block team setup.
