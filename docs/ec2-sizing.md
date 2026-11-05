# EC2 sizing

This deployment currently installs Ubuntu 24.04 and native OpenClaw on **x86_64**. Graviton/ARM instances require a separate tested AMI and bootstrap path. A low advertised EC2 price does not establish that a size can run this installation.

## Verified result

For this CLI, **2 GiB is the supported minimum**. In Frankfurt, **t3a.small is the cheapest verified x86 option** from the compared On-Demand sizes. The setup menu includes it; the portable default remains t3.small. Use 4 GiB or more for additional tools or team workloads; those workloads require their own capacity checks.

All three cases used OpenClaw 2026.11.1, Node.js 24.22.2, Ubuntu 24.04 amd64 AMI `ami-0c228cd2b65888e1b`, eu-central-1a, 30 GiB encrypted gp3, SSM-only access and CloudWatch, on 5 November 2026.

| Case                         | Result                                                                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| t3a.micro, 1 GiB, no swap    | Reached readiness checks, but no authenticated readiness was established. Console confirmed a kernel OOM kill; a read-only SSM diagnostic timed out. Stopped after that evidence.                                                                                  |
| t3a.micro, 1 GiB, 2 GiB swap | Bootstrap and authenticated health passed, with zero sampled kernel OOM kills. A routine configuration check failed with a 25-second command limit. The host had roughly 1 GiB swap occupied and load average around 8. It was not certified for reboot/model use. |
| t3a.small, 2 GiB, 2 GiB swap | Passed installation, native commands, authenticated health, private credential/role checks, reboot recovery and one real OpenRouter response. Zero sampled kernel OOM kills. Entire case including cleanup: 699 seconds.                                           |

The final 2 GiB case had about 546 MiB available RAM before reboot and 510 MiB afterward; Gateway RSS was approximately 0.86 and 1.19 GiB respectively. Swap persisted across reboot. The model test used GPT-4.1 Nano through OpenRouter with tools disabled and a 64-token output cap: 6,291 input tokens and 4 output tokens, matching the requested response. The agent command took about 40 seconds including CLI startup.

This was a bounded basic-workload smoke, not a sustained load, browser, backup or team benchmark. The 1 GiB result does not prove that every possible tuned setup fails; it does not meet this project's certification. Component command deadlines differed (25 seconds for the 1 GiB probe and 60 seconds for the final comparison), so this is not a controlled latency ranking. The supported floor reflects the successfully verified complete deployment.

All test stacks, instances, root volumes and temporary parameters were cleaned up. An independent final query found no active capacity-test instance. The original provider key was retained. No model request ran in either failed 1 GiB case.

Before new provisioning, AWS metadata must establish x86_64 and at least 2 GiB. Existing configurations remain manageable without automatic resizing. Valid AWS type names do not depend on CDK's possibly stale family enum.

## Price comparison

The following Linux, shared-tenancy On-Demand compute prices were retrieved from the official AWS Price List API for `eu-central-1` on 5 November 2026. All three T3a candidates are offered in that region; allocation in a particular availability zone still depends on capacity.

| Memory  | x86 candidate | USD/hour | ARM comparison (unsupported by this bootstrap) | USD/hour |
| ------- | ------------- | -------: | ---------------------------------------------- | -------: |
| 512 MiB | t3a.nano      |   0.0054 | t4g.nano                                       |   0.0048 |
| 1 GiB   | t3a.micro     |   0.0108 | t4g.micro                                      |   0.0096 |
| 2 GiB   | t3a.small     |   0.0216 | t4g.small                                      |   0.0192 |
| 4 GiB   | t3a.medium    |   0.0432 | t4g.medium                                     |   0.0384 |

The tested `t3.small` costs USD 0.024/hour for compute. At 730 hours, `t3a.micro` would cost about USD 7.88/month for compute alone. It is not a supported size for this deployment.

These prices exclude the 30 GiB EBS disk, public IPv4, CloudWatch, data transfer, surplus CPU credits, tax, and model usage. Spot prices and interruption behavior require a separate comparison. See [AWS On-Demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/), [Price List API](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_pricing_GetProducts.html), and [instance specifications](https://docs.aws.amazon.com/ec2/latest/instancetypes/gp.html).

## Minimum-size verification

OpenClaw documents a 1 GiB absolute minimum and recommends more memory. Its [small-host guide](https://docs.openclaw.ai/install/raspberry-pi) recommends 4 GiB for that setup and a persistent 2 GiB swapfile on hosts with 2 GiB or less. This is guidance to test against, rather than evidence that our complete AWS installation works on 1 GiB. The 512 MiB nano sizes fall below the documented minimum.

Fresh hosts with at most 2 GiB RAM receive a private 2 GiB swapfile on the encrypted root disk and persistent swappiness 10. Existing active swap is preserved; an inactive file at the managed path stops setup for inspection. Updating the CLI does not add swap to existing hosts automatically.

CPU-credit samples were collected during all cases. The untuned 1 GiB host exhausted its earned credits and accumulated surplus credits while failing readiness. Short startup samples do not establish steady-state CPU cost. Burstable-credit charges can reduce apparent savings; compare actual workloads rather than extrapolating these startup measurements to a month.

The tests used one disposable instance at a time within the approved three-deployment scope. A preliminary packaging invocation failed before any AWS stack/instance was created and is excluded from the hardware results.
