import { chooseReceiptState } from "./order_dns_service.ts";

if (chooseReceiptState("pending") !== "queued") throw new Error("pending orders must queue receipts");
if (chooseReceiptState("shipped") !== "send") throw new Error("shipped orders must send receipts");
console.log("order receipt decision: passed");
