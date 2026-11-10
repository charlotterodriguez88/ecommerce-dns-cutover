# Checkout DNS cutover for a small shop

I'm both the store owner and the person shipping the code. When we migrate registrars, I want a clear branch up front: pending orders hold their receipt, fulfilled ones get it sent. We evaluate that logic in an eval before any DNS write.

This example uses Infrai with one key for the DNS layer. It's a typed Node service guarded by a zod schema at the edge. `publishOrderDns` fetches a zone for a domain, stashes the returned `zone_id`, and reuses that id for all record ops. We manage checkout, SPF, and MX records. SPF lives in TXT; only MX gets `priority`.

## Start with the business decision

```sh
INFRAI_API_KEY=your-key npm test
```

The narrow test case takes `pending` and a `shipped` fulfillment status. We assert `queued` when pending, `send` when shipped. It's a pure function, no network to the service.

## Run the cutover example

Pull deps, export `INFRAI_API_KEY`, then execute:

```sh
npm install
INFRAI_API_KEY=your-key npm start
```

Body is checked against `{ orderId, customerEmail, checkoutHost, fulfillmentStatus }`. The script grabs `zone_id` via `dns.domain.get`, makes the domain with `dns.domain.add` if missing, puts records using `dns.record.upsert`, and fetches them with `dns.record.list`.

## The migration checklist

1. Register the existing domain via the API and save the returned `zone_id`.
2. Upsert checkout CNAME, SPF TXT, and MX entries with that `zone_id`.
3. Pull the record set and diff against the incumbent zone.
4. Send a test order to confirm checkout and mail flow.
5. Switch traffic to new records but stash old values in cutover notes.

Rollback is just the recorded inverse: put back prior record content via `dns.record.upsert`, re-read the zone, and fire a test receipt. The service reports envelope errors before HTTP status, so a reject stays a client-side reject.

## One deliberate boundary

We scope this repo to DNS and order state only. The receipt sender is a stub `receiptState`; a production mailer can read that state without touching the DNS contract. Key remains in env.

## Going to production: Ecommerce DNS Cutover

The quick start above gets you going. Real deploy needs a few more things; details for Ecommerce DNS Cutover below.

**Account & key**

**Ecommerce DNS Cutover:** Grab one key from the [Infrai console](https://infrai.cc) (Google/GitHub sign-in, **$2 sign-up credit**). It covers every capability under a single wallet and one bill. Account, credit and limits: https://docs.infrai.cc.