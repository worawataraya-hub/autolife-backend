require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();

/* =========================================================
   ENV
========================================================= */
const PORT = process.env.PORT || 4000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const JWT_SECRET = process.env.JWT_SECRET || "change-me";

const PADDLE_ENV = process.env.PADDLE_ENV || "sandbox";
const PADDLE_API_KEY = process.env.PADDLE_API_KEY;
const PADDLE_BASIC_PRICE_ID = process.env.PADDLE_BASIC_PRICE_ID;
const PADDLE_PRO_PRICE_ID = process.env.PADDLE_PRO_PRICE_ID;
const CHECKOUT_SUCCESS_URL = process.env.CHECKOUT_SUCCESS_URL;
const CHECKOUT_CANCEL_URL = process.env.CHECKOUT_CANCEL_URL;

// ✅ รองรับหลาย secret (Paddle rotate key)
const PADDLE_WEBHOOK_SECRETS = (
  process.env.PADDLE_WEBHOOK_SECRET_KEYS ||
  process.env.PADDLE_WEBHOOK_SECRET_KEY ||
  ""
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/* =========================================================
   ✅ 1) PADDLE WEBHOOK (RAW BODY ONLY) — MUST BE FIRST
========================================================= */
app.post(
  ["/api/paddle/webhook", "/paddle/webhook"],
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) {
        console.error("[PADDLE_WEBHOOK] body is not Buffer");
        return res.status(500).send("server misconfigured");
      }

      const signature = req.headers["paddle-signature"];
      if (!signature || PADDLE_WEBHOOK_SECRETS.length === 0) {
        return res.status(401).send("missing signature/secret");
      }

      // ts=...;h1=...
      const parts = {};
      for (const piece of String(signature).split(";")) {
        const [k, v] = piece.trim().split("=");
        if (!k || !v) continue;
        parts[k] = parts[k] || [];
        parts[k].push(v);
      }

      const ts = parts.ts?.[0];
      const h1List = parts.h1 || [];
      if (!ts || h1List.length === 0) {
        return res.status(401).send("bad signature header");
      }

      const rawBody = req.body.toString("utf8");
      const signedPayload = `${ts}:${rawBody}`;

      const verified = PADDLE_WEBHOOK_SECRETS.some((secret) => {
        const expected = crypto
          .createHmac("sha256", secret)
          .update(signedPayload)
          .digest("hex");

        const expectedBuf = Buffer.from(expected, "hex");

        return h1List.some((h1) => {
          const h1Buf = Buffer.from(h1, "hex");
          return (
            h1Buf.length === expectedBuf.length &&
            crypto.timingSafeEqual(h1Buf, expectedBuf)
          );
        });
      });

      if (!verified) {
        console.error("[PADDLE_WEBHOOK] signature mismatch");
        return res.status(401).send("signature mismatch");
      }

      // ✅ signature ผ่านแล้ว ค่อย parse JSON
      const event = JSON.parse(rawBody);
      const type = event.event_type || event.type;
      const data = event.data || event;

      console.log("[PADDLE_WEBHOOK] event:", type);

      // ---- transaction.completed / subscription ----
      if (
        type === "transaction.completed" ||
        type === "subscription.activated" ||
        type === "subscription.updated"
      ) {
        const priceId =
          data.items?.[0]?.price?.id ||
          data.items?.[0]?.price_id ||
          data.price_id;

        const email =
          data.customer?.email ||
          data.customer_email ||
          data.user_email;

        const PRICE_TO_PLAN = {
          [PADDLE_BASIC_PRICE_ID]: "basic",
          [PADDLE_PRO_PRICE_ID]: "pro",
        };

        const plan = PRICE_TO_PLAN[priceId];

        if (plan && email) {
          await supabase
            .from("users")
            .update({
              plan,
              paddle_customer_id: data.customer?.id || null,
              paddle_subscription_id: data.id || null,
            })
            .eq("email", String(email).toLowerCase());
        }
      }

      return res.status(200).send("ok");
    } catch (err) {
      console.error("[PADDLE_WEBHOOK] error", err);
      return res.status(500).send("error");
    }
  }
);

/* =========================================================
   ✅ 2) MIDDLEWARE อื่น ค่อยตามมา
========================================================= */
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================================================
   CLIENTS
========================================================= */
const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
});

/* =========================================================
   HEALTH CHECK
========================================================= */
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

/* =========================================================
   START SERVER
========================================================= */
app.listen(PORT, () => {
  console.log(`✅ AutoLife backend listening on http://localhost:${PORT}`);
});
