---
'@salza80/openclaw-aws': patch
---

Check EC2 memory and architecture before creating bootstrap or deployment resources. Reject hosts below this deployment's supported 2 GiB memory floor and ARM types incompatible with the x86_64 installation. Preserve valid AWS instance type names without depending on the bundled CDK enum. Replace stale monthly-price labels with capacity guidance and document the measured baseline.

Configure persistent private swap on fresh hosts with at most 2 GiB RAM, following upstream small-host guidance while retaining existing active swap.
