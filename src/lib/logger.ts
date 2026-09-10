import pino from "pino";
import { env } from "@/config/env";

export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.NODE_ENV === "production" ? "info" : "debug",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-razorpay-signature']",
      "*.password",
      "*.newPassword",
      "*.currentPassword",
      "*.otp",
      "*.token",
      "*.accessToken",
      "*.refreshToken",
    ],
    censor: "[redacted]",
  },
});
