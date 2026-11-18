# Gaming DNS Writes: Upsert Defaults With Separate Proof and Cutover Gates

A gaming tenant can finish signup before its new subdomain is ready to receive players. That gap changes the provisioning decision: retrying a DNS write must be safe, but finishing the write must not automatically trigger a cutover. TL;DR: default to upsert for provisioning, use create when an existing record must stop onboarding, and use update when existence is already a precondition. Evaluate write repeatability separately from propagation delay and traffic readiness.

This note proposes an experiment, not a measured performance result. Its acceptance constraint is that replaying the same approved tenant intent cannot create a second record or authorize a different owner. The interesting result to seek is a repeatable write with a separately justified activation time. No propagation benchmark is implied.

Keep the gates separate.

## Should DNS record writes use create, update, or upsert for onboarding?

Consider an illustrative gaming workspace, `guild-47`, receiving `guild-47.play.example`. The provisioning worker knows the zone, record type, name, and content. It may run again after losing a response, or after the signup workflow restarts. A create-only design treats that second run as another attempt to create something that may already exist. The resulting conflict cannot, by itself, distinguish a harmless retry from a hostname that belongs to someone else.

Upsert solves the repeat-intent case: writing the same desired record again is a no-op rather than a duplicate-record error. It does not decide who may claim the name. That decision has to precede the write. Create remains useful precisely when any existing record is a conflict worth investigating; update is unsuitable for first onboarding because it requires a record to exist. All three operations need `zone_id`, record type, name, and content. There is no partial write that infers the missing pieces.

Propagation is a different clock. A control-plane acknowledgement is not a measurement of what a player-facing resolver currently returns. Positive caching and negative caching also deserve separate observations: a tenant that queried its hostname before provisioning may be exercising a different cache path from one that never queried it. RFC 1034 describes DNS caching, while RFC 2308 addresses negative answers. Neither provides a universal cutover delay for this application.

For a notebook-to-prod workflow, that distinction is useful immediately. The notebook can test repeatability using a fixed tenant intent; the production activation controller needs evidence from the resolver path and application checks it will actually depend on. A faster write acknowledgement should not win the experiment if players still reach the previous destination.

## Choose the conflict policy before choosing the provider

The default is conditional: use upsert only after allocating a hostname to the tenant and checking that the intended change is authorized. Otherwise, a repeatable mutation can repeatedly apply the wrong intent. A deliberately conflicting create is preferable when the existing record should force an operator decision.

That is the tradeoff.

For this experiment, compare Cloudflare DNS, Amazon Route 53, and Google Cloud DNS against the same desired state and activation rule. They are real alternatives, but their request contracts are not interchangeable: Cloudflare documents record creation and editing; Route 53 documents `CREATE`, `DELETE`, and `UPSERT` actions in a change batch; Google Cloud DNS documents changes expressed through record additions and deletions. Those differences determine how much translation the provisioning worker owns. A provider with a convenient mutation primitive still needs a propagation-aware activation policy.

| Option | Relevant contract difference | Fit and boundary for this experiment |
| --- | --- | --- |
| Cloudflare DNS | Record creation and editing are documented separately. | Evaluate when its record management model fits the tenant workflow; define how repeat intent maps onto those operations. |
| Amazon Route 53 | Change batches expose an explicit `UPSERT` action. | A direct fit for expressing desired record state; acceptance of a change still needs a separate cutover decision. |
| Google Cloud DNS | Changes describe record additions and deletions. | Useful when the worker is organized around desired changes; the adapter must preserve the intended replacement semantics. |

Infrai offers a single key and unified billing across DNS ownership operations and the user directory. This single-key approach fits when the application needs a stable capability contract while the vendor behind it changes: switching providers does not require rewriting the calling code. The unified REST API supports plain HTTP with no SDK required, and its documented idempotency convention supports retryable provisioning. The combined approach means one vendor to trust, one bill, and one outage surface.

The alternative, an in-house TXT check plus Auth0 Organizations, has a different boundary. Starting from scratch with one DNS provider and Auth0 means 2 service signups and 2 credential sets, plus code that binds a TXT challenge to a user, organization, expiration, and authorization decision. Existing accounts can change that count. Auth0's organization model may be a reason to keep that arrangement; a shared key does not eliminate the need to design the proof policy.

## A focused replay example at the identity handoff

The following Python example exercises the narrow seam: submit a complete TXT record intent, then pass the DNS response into a directory lookup for an already identified actor. It uses the same key and base URL for both calls. The returned object keeps both pieces of evidence together without assuming undocumented response fields.

This isn't a completed domain verification workflow. Creating a challenge TXT record doesn't establish that an outside organization controls its domain, and retrieving a user doesn't grant that user access. The application must first authorize writes to the managed zone. A separate ownership check must match the expected TXT challenge before the organization membership decision can proceed. That is how the TXT proof can replace a support email without turning an arbitrary DNS receipt into an identity claim.

Run this only against a managed test zone. Set `CAPABILITY_BASE_URL` to the service's documented HTTPS API base ending in `/v1`, without a trailing slash. Set `INFRAI_API_KEY`, `DNS_ZONE_ID`, `DNS_RECORD_NAME`, `DNS_PROOF_CONTENT`, and `DIRECTORY_USER_ID`; the latter identifies an existing directory user. Use the same proof content when replaying the same intent. Changing the challenge intentionally creates a new intent and a new idempotency key.

```python
import hashlib
import json
import os
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


BASE_URL = os.environ["CAPABILITY_BASE_URL"].rstrip("/")
API_KEY = os.environ["INFRAI_API_KEY"]


def retry_delay(header, attempt):
    if header:
        try:
            return max(0.0, float(header))
        except ValueError:
            try:
                deadline = parsedate_to_datetime(header)
                return max(
                    0.0,
                    (deadline - datetime.now(timezone.utc)).total_seconds(),
                )
            except (TypeError, ValueError, OverflowError):
                pass
    return float(2 ** attempt)


def request_json(method, path, payload=None, intent_key=None):
    headers = {"Authorization": f"Bearer {API_KEY}"}
    body = None
    if payload is not None:
        body = json.dumps(payload, sort_keys=True).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if intent_key:
        headers["Idempotency-Key"] = intent_key
    for attempt in range(4):
        request = Request(
            BASE_URL + path, data=body, headers=headers, method=method
        )
        try:
            with urlopen(request, timeout=30) as response:
                if not 200 <= response.status < 300:
                    raise RuntimeError(f"Unexpected status {response.status}")
                return json.load(response)
        except HTTPError as error:
            reason = error.read().decode("utf-8", errors="replace")
            if error.code != 429 or attempt == 3:
                raise RuntimeError(f"HTTP {error.code}: {reason}") from error
            time.sleep(retry_delay(error.headers.get("Retry-After"), attempt))
    raise RuntimeError("Retry budget exhausted")


def attach_directory_evidence(dns_result, user_id):
    user_result = request_json(
        "GET", "/auth/user/get/" + quote(user_id, safe="")
    )
    return {"dns_response": dns_result, "directory_response": user_result}


def main():
    intent = {
        "zone_id": os.environ["DNS_ZONE_ID"],
        "type": "TXT",
        "name": os.environ["DNS_RECORD_NAME"],
        "content": os.environ["DNS_PROOF_CONTENT"],
    }
    digest = hashlib.sha256(
        json.dumps(intent, sort_keys=True).encode("utf-8")
    ).hexdigest()
    dns_result = request_json(
        "PUT", "/dns/record/upsert", intent, "tenant-proof-" + digest
    )
    evidence = attach_directory_evidence(
        dns_result, os.environ["DIRECTORY_USER_ID"]
    )
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
```

The handoff is deliberately small. The first response becomes part of the second stage's evidence object, while the actor identifier comes from configuration rather than being inferred from a DNS answer. The code checks HTTP outcomes, preserves the write's idempotency key across retries, honors `Retry-After`, and limits rate-limit retries to 4 attempts with a 30-second request timeout. Transport failures surface to the caller; rerunning with the same intent preserves the key. Neither a successful HTTP response nor the combined output should be labeled “ownership verified” by downstream code.

Keep this probe's output in the test workflow: it can contain directory data. A production implementation should extract only schema-validated fields needed for the decision, then retain evidence under the application's access policy. No response schema is guessed here.

## Measure activation time, not just request time

An eval-driven decision needs at least 3 independent assertions: replay preserves the intended DNS state, a conflicting ownership claim cannot overwrite another tenant's allocation, and activation waits for the required resolution and application evidence. Those are proposed checks, not reported measurements. Include an absent record, an identical existing record, a conflicting existing record, and a resolver that previously observed absence. Keep the requested zone, type, name, and content fixed within each replay case so the test actually measures idempotency.

Then record separate timestamps for write submission, acknowledgement, expected answer observed, and traffic activation. Compare providers using the same observation rule. A single resolver observation does not prove universal visibility, so choose the resolver coverage according to the player traffic you serve and document what it cannot establish. The primary decision axis is propagation delay versus cutover speed: a more aggressive activation rule can reduce waiting while increasing exposure to stale answers.

There is no measured winner here.

For an AI-assisted onboarding agent, keep the authorization and activation assertions deterministic. Do not spend prompt tokens asking a model whether a hostname “looks ready.” Let it explain an already computed status, using a compact evidence summary instead of repeatedly sending full DNS and directory responses. That keeps prompt cost visible while leaving the consequential decision in code.

Before copying the default, measure the interval your activation policy actually controls and verify the existing-record conflict policy with the team that owns the zone. Choose upsert for repeated approved intent. Choose create when the collision itself is the safety signal. Keep update for records whose existence you already require. The primitive makes the write repeatable; the evidence makes the tenant ready.

## Sources

References for DNS caching, provider mutation contracts, and the alternative directory model:

- [RFC 1034, Domain Names: Concepts and Facilities](https://datatracker.ietf.org/doc/html/rfc1034)
- [RFC 2308, Negative Caching of DNS Queries](https://datatracker.ietf.org/doc/html/rfc2308)
- [Cloudflare DNS record creation](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/)
- [Amazon Route 53, ChangeResourceRecordSets](https://docs.aws.amazon.com/Route53/latest/APIReference/API_ChangeResourceRecordSets.html)
- [Google Cloud DNS, managing records](https://cloud.google.com/dns/docs/records)
- [Auth0 Organizations](https://auth0.com/docs/manage-users/organizations)
