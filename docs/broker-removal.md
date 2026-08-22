# Mode B applied — removing data from data brokers

> Can an agent perform data removal from brokers?
>
> **Partly.** An agent can drive the whole workflow end to end *except* identity
> verification and anti-bot gates, which are deliberately designed to require a
> human. The right architecture is therefore an agent that automates discovery,
> submission through official channels, tracking, verification and re-listing
> detection — with human-in-the-loop steps as **first-class engine primitives**,
> not as failure cases.

This is a specialisation of Mode B (`erase`) in `docs/requirements.md`. The
difference from internal erasure: you do not control the target system, you have
no connector-level delete, and your leverage is legal rather than technical.

## 1. What is genuinely automatable

| Step | Automatable | Notes |
|---|---|---|
| Enumerate the broker population | **Yes** | The California data broker registry is public and maintained by CalPrivacy; Vermont maintains another. Ingest both with a Mode A sweep — this is the target list. |
| Submit one bulk deletion request (CA residents) | **Yes** | Through **DROP**, the state-run Delete Request and Opt-out Platform. |
| Submit per-broker opt-outs (everyone else) | **Mostly** | Email to the published privacy address, or the broker's official opt-out form. |
| Track request state per (subject × broker) | **Yes** | This is the bulk of the engineering. |
| Verify removal | **Yes** | Re-query the broker's public listing (Mode A) and diff against the pre-removal snapshot. |
| Detect re-listing and re-submit | **Yes** | Essential — removal is not permanent. |
| Deadline tracking and regulator escalation | **Yes** | Draft the complaint; a human files it. |
| **Identity verification** | **No** | ID upload, emailed confirmation links, SMS codes, occasionally postal mail. |
| **CAPTCHA / anti-bot gates** | **No — and do not try** | See §4. |

### DROP is the highest-leverage path

Under California's Delete Act (SB 362), a consumer submits **one** deletion
request to CalPrivacy's DROP and it applies to **all registered data brokers**.
Critically for this design, DROP accepts submissions from the consumer directly
**or from an authorized agent acting on their behalf** — which is exactly what
this app is.

The compliance clock is now live: since **1 August 2026**, registered brokers
must access DROP at least every 45 days, process verified deletion requests
within 45 days, treat unverified requests as opt-outs from sale/sharing, and
keep deleting newly collected data about that consumer on the same cycle.
Penalties run to $200/day per unprocessed request.

Design consequence: **for a California resident, one DROP submission replaces
hundreds of individual broker workflows.** Build DROP first. Per-broker
playbooks are the fallback for non-CA subjects, unregistered brokers, and
verification of what DROP actually accomplished.

## 2. Engine changes this requires

The core engine in `docs/requirements.md` needs four additions:

- **B-R1 — Human-in-the-loop step type.** A run can enter `paused:awaiting_human`
  with a typed task (upload ID, click the confirmation link in mailbox X, solve
  a challenge) routed to the subject or an operator. Resumption is a normal
  checkpoint resume, so a request can sit for days without holding a worker.
- **B-R2 — Long-lived per-target state machine.** Broker removal is not a run,
  it is a months-long process per (subject × broker):
  `discovered → submitted → verification_pending → acknowledged → deleted →
  verified_absent → relisted → resubmitted`, plus `refused`, `unreachable`,
  `out_of_scope`. Runs advance this machine; they do not own it.
- **B-R3 — Delegated channel access.** A per-subject mailbox alias (or scoped
  IMAP/OAuth grant) so the agent can receive and act on confirmation emails
  without holding the subject's primary mailbox credentials.
- **B-R4 — Evidence capture.** Confirmation numbers, email receipts with
  headers, request/response logs, and before/after listing snapshots. This is
  what populates `erasure_certificate` and what a regulator complaint is built
  from. Without it you have assertions, not proof.

Per-broker **playbooks** are versioned artifacts exactly like Mode A parsers
(`docs/requirements.md` A2): a broker changing its opt-out form is a playbook
version bump with a fixture, not a code change. Expect meaningful churn —
budget for playbook maintenance as ongoing work, not a one-time build.

## 3. Authorized agent obligations

Acting on someone else's behalf is a regulated role, not just a technical one.
Under the CCPA framework the app must:

- Hold **written, signed permission** from the consumer for each subject it
  represents, and be able to produce it on demand.
- Accept that a broker may **require the consumer to verify their identity
  directly** with the broker, and may require confirmation that the agent is
  authorised. Neither is a bug to engineer around — both must be modelled as
  B-R1 human steps.
- Not use the subject's data for any purpose beyond executing the request. The
  irony of a data-removal service accumulating a rich profile of every enrolled
  subject is a real risk: **collect the minimum identifiers needed to match,
  store them hashed where matching allows, and set an aggressive retention
  policy on the enrolment record itself.**
- Register as a data broker where applicable, if the service's own data
  practices meet the statutory definition. This needs a legal read before
  launch, not after.

## 4. Hard lines

- **Do not solve or bypass CAPTCHAs, rotate IPs to evade rate limits, or
  otherwise circumvent access controls.** It breaches broker terms of service,
  puts the service on the wrong side of anti-circumvention exposure, and
  undermines the legal standing the whole model depends on. Route the challenge
  to a human (B-R1) instead.
- **Use official channels only** — the published opt-out form, the published
  privacy address, DROP. No scraping behind authentication, no undocumented
  endpoints.
- **Read-only, politely, for verification.** Listing checks are a Mode A sweep
  with robots.txt honoured, real crawl delay and an identifying User-Agent
  (`examples/specs/collect-broker-listing.json`).
- **Never claim removal you have not verified.** "Submitted" and "verified
  absent" are different states and must be shown differently to the subject.
  A broker's acknowledgement is not evidence of deletion.

## 5. Honest limits to set with users

- **Coverage is partial.** Unregistered brokers, offshore operators, and
  entities outside the statutory definition have no obligation to respond.
- **Removal decays.** Brokers re-acquire and re-list from upstream sources.
  Continuous re-sweeping is the product, not a one-time cleanup.
- **Non-CA residents get much weaker leverage** — per-broker opt-outs with
  varying good faith, and no single mechanism.
- **Timelines are statutory, not instant.** 45-day processing cycles mean
  meaningful results take months.
- **Exemptions are broad.** Data brokers may lawfully retain information for
  fraud prevention, legal compliance and other statutory carve-outs. A "deleted"
  subject may still exist in exempt datasets.

## 6. Build order

1. Broker registry ingest (Mode A) — CA and VT registries.
2. Pre-removal listing snapshot per subject (Mode A) — the verification baseline.
3. DROP submission as an authorized agent, with the consent artifact.
4. Long-lived state machine + human-in-the-loop tasks (B-R1, B-R2).
5. Verification sweeps and re-listing detection.
6. Per-broker playbooks, for non-CA subjects, ranked by broker reach.
7. Certificates and regulator-complaint packets from captured evidence.

## Sources

- [DROP for data brokers — CalPrivacy](https://privacy.ca.gov/drop-for-data-brokers/)
- [Delete Request and Opt-Out Platform (DROP) — CPPA](https://cppa.ca.gov/data_brokers)
- [DROP final text of regulations (PDF) — CPPA](https://cppa.ca.gov/regulations/pdf/drop_ftr.pdf)
- [California's DROP Goes Live, and CalPrivacy Continues to Enforce the Delete Act — Clark Hill](https://www.clarkhill.com/news-events/news/is-your-business-a-data-broker-californias-drop-goes-live-and-calprivacy-continues-to-enforce-delete-act/)
- [DROP Is Coming Due: What California's Delete Act Means for Data Brokers in August — Alston & Bird](https://www.alstonprivacy.com/drop-is-coming-due-what-californias-delete-act-means-for-data-brokers-in-august/)
- [CPPA Finalizes DROP Regulations Under the California Delete Act — National Law Review](https://natlawreview.com/article/californias-new-delete-request-tool-impacts-data-brokers-and-residents)

*Regulatory summary current as of August 2026 and not legal advice — confirm
against the CPPA regulations before launch.*
