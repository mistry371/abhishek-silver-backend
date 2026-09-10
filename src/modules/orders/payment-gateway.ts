import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/config/env";
import { logger } from "@/lib/logger";

export interface PaymentGateway {
  readonly name: "demo" | "razorpay";
  readonly keyId?: string;
  createPayment(order: { id: string; orderNumber: string; amount: number }): Promise<{ providerOrderId: string }>;
  verifySignature(input: { providerOrderId: string; providerPaymentId: string; signature: string }): boolean;
  paymentMethod(providerPaymentId: string): Promise<string | null>;
  verifyWebhook(rawBody: Buffer, signature: string): boolean;
  /** Refunds (part of) a captured payment back to the original method. Amount in rupees. */
  refund(providerPaymentId: string, amount: number): Promise<{ refundId: string }>;
}

function safeEqual(expected: string, actual: string) {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Development gateway — the storefront's demo dialog posts "demo_valid_signature" for success. */
class DemoGateway implements PaymentGateway {
  readonly name = "demo" as const;

  async createPayment(order: { orderNumber: string }) {
    return { providerOrderId: `order_demo_${order.orderNumber}` };
  }

  verifySignature({ signature }: { signature: string }) {
    return signature === "demo_valid_signature";
  }

  async paymentMethod() {
    return "Demo payment";
  }

  verifyWebhook() {
    return false;
  }

  async refund() {
    return { refundId: `rfnd_demo_${Date.now()}` };
  }
}

const RAZORPAY_API = "https://api.razorpay.com/v1";
const methodLabels: Record<string, string> = {
  card: "Card",
  upi: "UPI",
  netbanking: "Net banking",
  wallet: "Wallet",
  emi: "EMI",
  paylater: "Pay later",
};

class RazorpayGateway implements PaymentGateway {
  readonly name = "razorpay" as const;
  readonly keyId = env.RAZORPAY_KEY_ID;
  private readonly authorization = `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64")}`;

  async createPayment(order: { id: string; orderNumber: string; amount: number }) {
    const response = await fetch(`${RAZORPAY_API}/orders`, {
      method: "POST",
      headers: { Authorization: this.authorization, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: Math.round(order.amount * 100),
        currency: "INR",
        receipt: order.orderNumber,
        notes: { orderId: order.id, orderNumber: order.orderNumber },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      logger.error({ status: response.status, orderNumber: order.orderNumber }, "Razorpay order creation failed");
      throw new Error("Razorpay order creation failed");
    }
    const data = (await response.json()) as { id: string };
    return { providerOrderId: data.id };
  }

  verifySignature({ providerOrderId, providerPaymentId, signature }: { providerOrderId: string; providerPaymentId: string; signature: string }) {
    const expected = createHmac("sha256", env.RAZORPAY_KEY_SECRET!).update(`${providerOrderId}|${providerPaymentId}`).digest("hex");
    return safeEqual(expected, signature);
  }

  async paymentMethod(providerPaymentId: string) {
    try {
      const response = await fetch(`${RAZORPAY_API}/payments/${encodeURIComponent(providerPaymentId)}`, {
        headers: { Authorization: this.authorization },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as { method?: string };
      return data.method ? (methodLabels[data.method] ?? data.method) : null;
    } catch {
      return null;
    }
  }

  async refund(providerPaymentId: string, amount: number) {
    const response = await fetch(`${RAZORPAY_API}/payments/${encodeURIComponent(providerPaymentId)}/refund`, {
      method: "POST",
      headers: { Authorization: this.authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: Math.round(amount * 100) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      logger.error({ status: response.status }, "Razorpay refund failed");
      throw new Error("Razorpay refund failed");
    }
    const data = (await response.json()) as { id: string };
    return { refundId: data.id };
  }

  verifyWebhook(rawBody: Buffer, signature: string) {
    if (!env.RAZORPAY_WEBHOOK_SECRET || !signature) return false;
    const expected = createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest("hex");
    return safeEqual(expected, signature);
  }
}

let gateway: PaymentGateway | null = null;

export function paymentGateway(): PaymentGateway {
  gateway ??= env.PAYMENT_PROVIDER === "razorpay" ? new RazorpayGateway() : new DemoGateway();
  return gateway;
}

export const razorpayMethodLabel = (method: string | undefined) => (method ? (methodLabels[method] ?? method) : null);
