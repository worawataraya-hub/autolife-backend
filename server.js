/**
 * AutoLife Backend - server.js (fixed Paddle webhook raw-body verification)
 * - Webhook routes use express.raw() BEFORE json middleware
 * - Verifies Paddle Notifications v2 signature header: "paddle-signature"
 * - Supports multiple secrets via env:
 *    - PADDLE_WEBHOOK_SECRET_KEYS="key1,key2" (recommended)
 *    - or PADDLE_WEBHOOK_SECRET_KEY / PADDLE_WEBHOOK_SECRET
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createHmac, timingSafeEqual } = require("crypto");

const app = express();

// If you're using cookies/auth, adjust CORS accordingly.
app.use(cors({ origin: true, credentials: true }));

/** -------------------------
 *  0) Basic health checks
 *  ------------------------- */
app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

/** -------------------------
 *  1) Paddle Webhook (RAW)
 *  IMPORTANT: must be declared BEFORE express.json()
 *  ------------------------- */
function getPaddleSecrets() {
  const raw =
    process.env.PADDLE_WEBHOOK_SECRET_KEYS ||
    process.env.PADDLE_WEBHOOK_SECRET_KEY ||
    process.env.PADDLE_WEBHOOK_SECRET ||
    "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseSignatureHeader(headerValue) {
  // Example: "ts=1700000000;h1=abcdef...;h1=..."
  const parts = {};
  for (const piece of String(headerValue || "").split(";")) {
    const [k, v] = piece.trim().split("=");
    if (!k || !v) continue;
    parts[k] = parts[k] || [];
    parts[k].push(v);
  }
  return {
    ts: parts.ts?.[0],
    h1List: parts.h1 || [],
  };
}

function verifyPaddleSignature({ signatureHeader, rawBody, secrets }) {
  if (!signatureHeader) return { ok: false, reason: "missing signature header" };
  if (!secrets || secrets.length === 0) return { ok: false, reason: "missing secret keys" };
  const { ts, h1List } = parseSignatureHeader(signatureHeader);
  if (!ts || h1List.length === 0) return { ok: false, reason: "bad signature header" };

  const signedPayload = `${ts}:${rawBody}`; // Paddle Notifications v2 format

  const ok = secrets.some((secret) => {
    const expectedHex = createHmac("sha256", secret).update(signedPayload).digest("hex");
    const expectedBuf = Buffer.from(expectedHex, "hex");

    return h1List.some((h1) => {
      // h1 is hex
      if (!/^[0-9a-fA-F]+$/.test(h1)) return false;
      const h1Buf = Buffer.from(h1, "hex");
      return h1Buf.length === expectedBuf.length && timingSafeEqual(h1Buf, expectedBuf);
    });
  });

  return ok ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

// RAW body ONLY for webhook routes
app.post(
  ["/api/paddle/webhook", "/paddle/webhook"],
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) {
        console.error("[PADDLE_WEBHOOK] body is not Buffer (raw middleware not applied)");
        return res.status(500).send("server misconfigured");
      }

      // Header keys in Node are lowercased
      const paddleSignature = req.headers["paddle-signature"] || req.headers["paddle_signature"];
      const secrets = getPaddleSecrets();

      if (!paddleSignature || secrets.length === 0) {
        console.error("[PADDLE_WEBHOOK] missing signature/secret", {
          hasSignature: !!paddleSignature,
          secretCount: secrets.length,
        });
        return res.status(401).send("missing signature/secret");
      }

      const rawBody = req.body.toString("utf8");
      const check = verifyPaddleSignature({
        signatureHeader: paddleSignature,
        rawBody,
        secrets,
      });

      if (!check.ok) {
        console.error("[PADDLE_WEBHOOK] signature failed:", check.reason);
        return res.status(401).send(check.reason);
      }

      // ✅ signature OK: now parse JSON
      let event;
      try {
        event = JSON.parse(rawBody);
      } catch (e) {
        console.error("[PADDLE_WEBHOOK] JSON parse error", e);
        return res.status(400).send("invalid json");
      }

      // TODO: anti-duplicate (recommended)
      // - store event.id (or notification id) into DB table (unique)
      // - if already processed: return 200

      // TODO: business logic
      // Example events you care about:
      // - transaction.completed
      // - subscription.activated / subscription.updated / subscription.canceled
      // console.log("[PADDLE_WEBHOOK] event:", event?.event_type, event?.data?.id);

      // Important: respond 200 quickly, do heavy work async
      res.status(200).send("ok");

      // ---- async processing (example) ----
      // process.nextTick(async () => {
      //   await handlePaddleEvent(event);
      // });

    } catch (err) {
      console.error("[PADDLE_WEBHOOK] error", err);
      return res.status(500).send("error");
    }
  }
);

/** -------------------------
 *  2) JSON middleware for ALL other routes
 *  ------------------------- */
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/** -------------------------
 *  3) Other routes (keep yours below)
 *  ------------------------- */
// Example placeholder:
app.get("/api/status", (req, res) => res.json({ status: "ok" }));

/** -------------------------
 *  4) Start server
 *  ------------------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`AutoLife backend listening on http://localhost:${PORT}`);
});
