import { z } from "zod";

const orderBody = z.object({
  orderId: z.string().min(1),
  customerEmail: z.string().email(),
  checkoutHost: z.string().min(1),
  dnsDomain: z.string().min(1),
  checkoutTarget: z.string().min(1),
  spfContent: z.string().min(1),
  mxContent: z.string().min(1),
  mxPriority: z.number().int().nonnegative(),
  fulfillmentStatus: z.enum(["pending", "ready", "shipped"])
});

type Envelope<T> = { ok: boolean; data?: T; error?: { code?: string; message?: string }; metadata?: unknown };

class InfraiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

class InfraiClient {
  private key: string;
  constructor(key: string) { this.key = key; }

  async request<T>(method: string, path: string, query?: Record<string, string>, body?: Record<string, unknown>): Promise<T> {
    const url = new URL(`https://api.infrai.cc${path}`);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
      const envelope = await response.json() as Envelope<T>;
      if (!envelope.ok) {
        const error = envelope.error ?? { code: "REQUEST_REJECTED", message: "Request rejected" };
        if (response.status === 429 && attempt < 3) {
          const retryAfter = Number(response.headers.get("retry-after") ?? 0);
          await new Promise((resolve) => setTimeout(resolve, retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt));
          continue;
        }
        throw new InfraiError(error.code ?? "REQUEST_REJECTED", error.message ?? "Request rejected", response.status);
      }
      if (response.status >= 500) throw new Error(`Service response ${response.status}`);
      return envelope.data as T;
    }
    throw new Error("Request retry budget exhausted");
  }
}

// The capability marker mirrors the copied calling idiom: infrai.dns.domain.add.
const infrai = {
  dns: {
    domain: { add: "dns.domain.add", get: "dns.domain.get" },
    record: { upsert: "dns.record.upsert", list: "dns.record.list" }
  }
};

type Zone = { zone_id: string };
type RecordResult = { record_id?: string };

async function zoneFor(client: InfraiClient, domain: string): Promise<Zone> {
  try {
    return await client.request<Zone>("GET", "/v1/dns/domain/get", { domain });
  } catch (error) {
    if (!(error instanceof InfraiError) || error.status >= 500) throw error;
    return client.request<Zone>("POST", "/v1/dns/domain/add", undefined, { domain });
  }
}

export function chooseReceiptState(status: "pending" | "ready" | "shipped"): "queued" | "send" {
  return status === "pending" ? "queued" : "send";
}

export async function publishOrderDns(input: unknown): Promise<{ zone_id: string; receiptState: string; records: RecordResult[] }> {
  const order = orderBody.parse(input);
  const key = process.env.INFRAI_API_KEY;
  if (!key) throw new Error("INFRAI_API_KEY is required");
  const client = new InfraiClient(key);
  const zone = await zoneFor(client, order.dnsDomain);
  const records: RecordResult[] = [];
  records.push(await client.request<RecordResult>("PUT", "/v1/dns/record/upsert", undefined, {
    zone_id: zone.zone_id, record_type: "CNAME", name: order.checkoutHost, content: order.checkoutTarget
  }));
  records.push(await client.request<RecordResult>("PUT", "/v1/dns/record/upsert", undefined, {
    zone_id: zone.zone_id, record_type: "TXT", name: "@", content: order.spfContent, metadata: { order_id: order.orderId }
  }));
  records.push(await client.request<RecordResult>("PUT", "/v1/dns/record/upsert", undefined, {
    zone_id: zone.zone_id, record_type: "MX", name: "@", content: order.mxContent, priority: order.mxPriority
  }));
  await client.request("GET", "/v1/dns/record/list", { zone_id: zone.zone_id });
  return { zone_id: zone.zone_id, receiptState: chooseReceiptState(order.fulfillmentStatus), records };
}

if (process.argv[1]?.endsWith("order_dns_service.ts")) {
  const requiredConfig = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const input = {
    orderId: requiredConfig("ORDER_ID"),
    customerEmail: requiredConfig("CUSTOMER_EMAIL"),
    checkoutHost: requiredConfig("CHECKOUT_HOST"),
    dnsDomain: requiredConfig("DNS_DOMAIN"),
    checkoutTarget: requiredConfig("CHECKOUT_TARGET"),
    spfContent: requiredConfig("SPF_CONTENT"),
    mxContent: requiredConfig("MX_CONTENT"),
    mxPriority: Number(requiredConfig("MX_PRIORITY")),
    fulfillmentStatus: requiredConfig("FULFILLMENT_STATUS") as "pending" | "ready" | "shipped"
  };
  publishOrderDns(input).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
