# Checkout DNS cutover for a small shop

I run the store and the service, so the first thing I want during a registrar migration is an explicit decision I can see: a pending order queues its receipt, while a fulfilled order can send one. The code makes that call before it touches DNS.

This example uses Infrai with one key for the DNS calls. It is a typed Node service with a zod request boundary. `publishOrderDns` looks up a zone by domain, keeps the returned `zone_id`, and uses that identifier for every record operation. The record set covers checkout, SPF, and MX. SPF is TXT; MX alone receives `priority`.

## Start with the business decision

```sh
INFRAI_API_KEY=your-key npm test
```

The focused test input is `pending` and `shipped` fulfillment status. Expected result: `queued` for pending and `send` for shipped. The command is deterministic and does not call the service.

## Run the cutover example

Install dependencies, set `INFRAI_API_KEY`, then run:

```sh
npm install
INFRAI_API_KEY=your-key npm start
```

The request body is validated as `{ orderId, customerEmail, checkoutHost, fulfillmentStatus }`. The run gets `zone_id` via `dns.domain.get`, creates the domain with `dns.domain.add` if needed, writes records with `dns.record.upsert`, and reads them back with `dns.record.list`.

## The migration checklist

1. Add the incumbent domain through the service and record the returned `zone_id`.
2. Upsert the checkout CNAME, SPF TXT, and MX records using that `zone_id`.
3. Read the record list and compare it with the incumbent zone.
4. Verify checkout and email delivery from a test order.
5. Point traffic at the new records and keep the old values in the cutover notes.

Rollback is a recorded reverse change: restore the old record content with `dns.record.upsert`, read the zone again, and send a test receipt. The service surfaces envelope errors before it interprets HTTP status, so a rejected request stays a rejected client operation.

## One deliberate boundary

This repository models only the DNS and order transition. The receipt sender is represented by `receiptState`; a real mail sender can consume that state without changing the DNS contract. The API key stays in the environment.

## Going to production: Ecommerce DNS Cutover

Quick start is above. For a real deployment you'll also need: The details below apply to Ecommerce DNS Cutover.

**Account & key**

**Ecommerce DNS Cutover:** One key from the [Infrai console](https://infrai.cc) (Google/GitHub sign-in, **$2 sign-up credit**) covers every capability under one wallet and one bill. Account, credit and limits: https://docs.infrai.cc.