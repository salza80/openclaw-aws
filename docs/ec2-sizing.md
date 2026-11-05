# EC2 sizing

This deployment currently installs Ubuntu 24.04 and native OpenClaw on **x86_64**. Graviton/ARM instances require a separate tested AMI and bootstrap path. A low advertised EC2 price does not establish that a size can run this installation.

## Current evidence

On 5 November 2026, an isolated `t3.small` (2 GiB, 2 vCPU) passed fresh installation of OpenClaw 2026.11.1 with Node.js 24.22.2, authenticated Gateway health, native model status, private credential-reference checks, SSM/CloudWatch, and recovery after reboot. Its provider was OpenRouter; no model inference was sent.

The Gateway used approximately 1.0–1.1 GiB resident memory. Available host memory was about 365 MiB before reboot and 297 MiB afterward. The complete reboot verification took 361 seconds and required several retries. Filtered console checks did not establish an out-of-memory event. All test resources were deleted afterward.

This establishes a basic 2 GiB baseline. It does **not** establish reliable 1 GiB operation, sustained workloads, browser automation, or team capacity.

The interactive menu currently starts at `t3.small`; 1 GiB sizes remain unverified and are absent from that menu. Before creating deployment resources, the CLI checks AWS instance metadata for x86_64 support and at least the documented 1 GiB minimum. This capability check does not certify a 1 GiB workload. Existing configurations remain usable for lifecycle operations. Issue [#21](https://github.com/salza80/openclaw-aws/issues/21) tracks the remaining runtime benchmark.

## Price comparison

The following Linux, shared-tenancy On-Demand compute prices were retrieved from the official AWS Price List API for `eu-central-1` on 5 November 2026. All three T3a candidates are offered in that region; allocation in a particular availability zone still depends on capacity.

| Memory  | x86 candidate | USD/hour | ARM comparison (unsupported by this bootstrap) | USD/hour |
| ------- | ------------- | -------: | ---------------------------------------------- | -------: |
| 512 MiB | t3a.nano      |   0.0054 | t4g.nano                                       |   0.0048 |
| 1 GiB   | t3a.micro     |   0.0108 | t4g.micro                                      |   0.0096 |
| 2 GiB   | t3a.small     |   0.0216 | t4g.small                                      |   0.0192 |
| 4 GiB   | t3a.medium    |   0.0432 | t4g.medium                                     |   0.0384 |

The tested `t3.small` costs USD 0.024/hour for compute. At 730 hours, `t3a.micro` would cost about USD 7.88/month for compute alone. Its runtime suitability remains unverified.

These prices exclude the 30 GiB EBS disk, public IPv4, CloudWatch, data transfer, surplus CPU credits, tax, and model usage. Spot prices and interruption behavior require a separate comparison. See [AWS On-Demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/), [Price List API](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_pricing_GetProducts.html), and [instance specifications](https://docs.aws.amazon.com/ec2/latest/instancetypes/gp.html).

## Minimum-size verification

OpenClaw documents a 1 GiB absolute minimum and recommends more memory. Its [small-host guide](https://docs.openclaw.ai/install/raspberry-pi) recommends 4 GiB for that setup and a persistent 2 GiB swapfile on hosts with 2 GiB or less. This is guidance to test against, rather than evidence that our complete AWS installation works on 1 GiB. The 512 MiB nano sizes fall below the documented minimum.

The planned isolated test sequence is:

1. Deploy the current packaged CLI on `t3a.micro` without additional tuning.
2. If necessary, test a fresh 1 GiB deployment using a reviewed product implementation of the upstream swap/tuning guidance.
3. Test `t3a.small` as the lower-cost 2 GiB reference.

Each case must exercise cold installation, service-user runtime discovery, authenticated health and native model commands while the Gateway runs, reboot recovery, and a bounded workload. A minimal real OpenRouter response is part of the proposed additional test scope. Measure resident/available memory, swap, kernel OOM evidence, command latency and CPU credits. Keep the verified minimum separate from recommended capacity for tools, backups and teams.

Use one disposable deployment at a time, a bounded approved budget and deadline, and verified cleanup before the next case. The additional benchmark budget is pending; no smaller-size deployment has been tested yet. Record exact runtime/AMI/architecture, tuning and workload with the results. Existing installations must not be resized automatically.
