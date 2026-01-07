/**
 * AutoLife backend (Render deploy-ready)
 * Phase 1: Stable quota control + Paddle checkout/webhook
 *
 * SPEC (Thailand time, GMT+7):
 * - FREE  : 20 calls / day  (reset at 00:00 Asia/Bangkok)  -> enforce, return 402 when exceeded
 * - BASIC : 300 calls / month (reset 1st day of month Asia/Bangkok) -> enforce, return 402 when exceeded
 * - PRO   : unlimited -> no quota check
 *
 * UX status:
 * - 401: please login
 * - 402: quota exceeded (upgrade)
 * - 429: system busy / upstream rate limited
 * - 500: server error
 */
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
// ---------- OBSERVABILITY / UTILITIES (v42) ----------
function makeRequestId() {
  try {
    return (crypto && typeof crypto.randomUUID === "function")
      ? crypto.randomUUID()
      : (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));
  } catch (_) {
    return (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));
  }
}
function truncateLog(str, max = 700) {
  if (str === undefined || str === null) return "";
  const s = String(str);
  return s.length > max ? (s.slice(0, max) + "…(truncated)") : s;
}

// Simple in-memory cache (good enough for Render single instance; swap to Redis later)
const _memCache = new Map(); // key -> { exp:number, value:any }
function cacheGet(key) {
  const v = _memCache.get(key);
  if (!v) return null;
  if (v.exp && Date.now() > v.exp) {
    _memCache.delete(key);
    return null;
  }
  return v.value;
}
function cacheSet(key, value, ttlMs) {
  _memCache.set(key, { exp: ttlMs ? (Date.now() + ttlMs) : 0, value });
}

// Simple per-IP rate limiter (no deps)
const _rateState = new Map(); // ip -> { reset:number, count:number }
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const ipRaw = req.headers["x-forwarded-for"];
    const ip = (typeof ipRaw === "string" && ipRaw.length)
      ? ipRaw.split(",")[0].trim()
      : (req.ip || "unknown");
    const now = Date.now();
    let s = _rateState.get(ip);
    if (!s || now > s.reset) {
      s = { reset: now + windowMs, count: 0 };
      _rateState.set(ip, s);
    }
    s.count += 1;

    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - s.count)));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(s.reset / 1000)));

    if (s.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((s.reset - now) / 1000)));
      return res.status(429).json({
        ok: false,
        error: "Rate limit exceeded",
        requestId: req.requestId || null
      });
    }
    return next();
  };
}
const aiLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 30 });
// ---------- /OBSERVABILITY / UTILITIES ----------


// ---------- ENV ----------
const PORT = process.env.PORT || 10000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const JWT_SECRET = process.env.JWT_SECRET || "change-me";

const PADDLE_ENV = (process.env.PADDLE_ENV || "sandbox").toLowerCase(); // sandbox | live
const PADDLE_API_KEY = (process.env.PADDLE_API_KEY || "").trim();
const PADDLE_WEBHOOK_SECRET = (process.env.PADDLE_WEBHOOK_SECRET || "").trim();

const PADDLE_BASIC_PRICE_ID = (process.env.PADDLE_BASIC_PRICE_ID || "").trim();
const PADDLE_PRO_PRICE_ID = (process.env.PADDLE_PRO_PRICE_ID || "").trim();

const CHECKOUT_SUCCESS_URL = process.env.CHECKOUT_SUCCESS_URL;
const CHECKOUT_CANCEL_URL = process.env.CHECKOUT_CANCEL_URL;
// ---------- Helpers ----------
function cleanHeaderValue(v) {
  // Remove all control characters and whitespace that can break Node's HTTP header validation.
  // (Render env vars sometimes include trailing newlines when pasted.)
  let s = String(v ?? "");
  // Strip "Bearer " if the user pasted a full auth header into the env var.
  s = s.replace(/^Bearer\s+/i, "");
  // Remove ASCII control chars + DEL
  s = s.replace(/[\u0000-\u001F\u007F]/g, "");
  // Remove all whitespace (keys shouldn't contain spaces/tabs/newlines)
  s = s.replace(/\s+/g, "");
  return s;
}

function sanitizeRedirectUrl(raw) {
  if (!raw) return raw;
  try {
    const u = new URL(String(raw));
    u.hash = "";
    return u.toString();
  } catch {
    return String(raw);
  }
}



// ---------- VALIDATION ----------
function must(name, value) {
  if (!value) console.warn(`⚠️ Missing env: ${name}`);
}
must("SUPABASE_URL", SUPABASE_URL);
must("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY);
must("JWT_SECRET", JWT_SECRET);
must("PADDLE_API_KEY", PADDLE_API_KEY);
must("PADDLE_WEBHOOK_SECRET", PADDLE_WEBHOOK_SECRET);
must("PADDLE_BASIC_PRICE_ID", PADDLE_BASIC_PRICE_ID);
must("PADDLE_PRO_PRICE_ID", PADDLE_PRO_PRICE_ID);
must("CHECKOUT_SUCCESS_URL", CHECKOUT_SUCCESS_URL);
must("CHECKOUT_CANCEL_URL", CHECKOUT_CANCEL_URL);
must("GEMINI_API_KEY", GEMINI_API_KEY);

// ---------- MIDDLEWARE ----------
// CORS: allow Netlify frontend + local dev.
// Set CORS_ORIGINS as comma-separated list (recommended) to be strict in production.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// sensible defaults (your known frontends)
if (!ALLOWED_ORIGINS.length) {
  ALLOWED_ORIGINS.push(
    // Netlify production site (Origin never has a trailing slash, but keep it clean anyway)
    "https://autolife-ai.netlify.app",
    "http://localhost:5173",
    "http://localhost:3000",
    "http://localhost:5500",
  );
}

const corsOptions = {
  origin(origin, cb) {
    // allow server-to-server / curl (no Origin)
    if (!origin) return cb(null, true);

    const o = String(origin).replace(/\/$/, "");
    const allowList = new Set(ALLOWED_ORIGINS.map((x) => String(x).replace(/\/$/, "")));
    if (allowList.has(o)) return cb(null, true);

    // Allow any Netlify site / deploy preview under netlify.app
    // (Netlify preview origins look like: https://<hash>--<site>.netlify.app)
    if (/^https:\/\/[a-z0-9-]+(?:--[a-z0-9-]+)?\.netlify\.app$/i.test(o)) return cb(null, true);

    // Local dev convenience
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o)) return cb(null, true);

    return cb(new Error(`CORS blocked for origin: ${o}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.options("*", cors(corsOptions));
const jsonParser = express.json({
  limit: "2mb",
  verify: (req, res, buf) => {
    // Keep rawBody for debugging / future signature checks on JSON routes
    req.rawBody = buf;
  },
});
app.use((req, res, next) => {
  // IMPORTANT: Paddle webhook uses express.raw() to verify signature.
  // Do not pre-consume body via jsonParser.
  if (req.originalUrl && req.originalUrl.startsWith("/api/paddle/webhook")) return next();
  return jsonParser(req, res, next);
});

// Trust proxy (Render/Netlify) so req.ip works correctly
app.set("trust proxy", 1);

// RequestId + latency log (one line start/end)
app.use((req, res, next) => {
  const requestId = req.headers["x-request-id"] || makeRequestId();
  req.requestId = requestId;
  const t0 = Date.now();
  res.setHeader("X-Request-Id", requestId);

  console.log(JSON.stringify({
    t: "start",
    id: requestId,
    method: req.method,
    path: req.originalUrl,
    ip: req.headers["x-forwarded-for"] || req.ip || null
  }));

  res.on("finish", () => {
    console.log(JSON.stringify({
      t: "end",
      id: requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - t0
    }));
  });

  next();
});

// ---------- SUPABASE ----------

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- Usage table column compatibility (older DB might use 'date'/'month' instead of 'date_key'/'month_key') ---
let DAILY_KEY_COL = process.env.DAILY_KEY_COL || 'date';
let MONTH_KEY_COL = process.env.MONTH_KEY_COL || 'month';
let DAILY_COUNT_COL = process.env.DAILY_COUNT_COL || 'used';
// NOTE: your Supabase screenshot shows public.usage_monthly uses column `count`
// (while public.usage_daily uses column `used`).
let MONTH_COUNT_COL = process.env.MONTH_COUNT_COL || 'count';
let _usageColsProbed = false;

const COUNT_CANDIDATES = ['count', 'used', 'used_count', 'usage', 'usage_count', 'calls', 'call_count'];

async function probeUsageColumns() {
  if (_usageColsProbed) return;
  _usageColsProbed = true;

  // Probe daily (key column + count column)
  try {
    const probeVal = '1900-01-01';
    const { error } = await supabase
      .from('usage_daily')
      .select(DAILY_COUNT_COL)
      .eq('user_id', 'probe')
      .eq(DAILY_KEY_COL, probeVal)
      .limit(1);

    if (error && (error.code === '42703' || error.code === 'PGRST204') && String(error.message || '').includes('date_key')) {
      DAILY_KEY_COL = 'date';
      console.warn('[probe] usage_daily missing date_key; falling back to column: date');
    }

    // If selected count column is missing, try candidates (ex: `used` vs `count`).
    if (error && (error.code === '42703' || error.code === 'PGRST204')) {
      for (const cand of COUNT_CANDIDATES) {
        try {
          const { error: e2 } = await supabase
            .from('usage_daily')
            .select(cand)
            .eq('user_id', 'probe')
            .eq(DAILY_KEY_COL, probeVal)
            .limit(1);
          if (!e2) {
            DAILY_COUNT_COL = cand;
            console.warn(`[probe] usage_daily count column not found; falling back to column: ${cand}`);
            break;
          }
        } catch {}
      }
    }
  } catch (e) {
    console.warn('[probe] usage_daily probe exception:', e?.message || e);
  }

  // Probe monthly (key column + count column)
  try {
    const probeVal = '1900-01';
    const { error } = await supabase
      .from('usage_monthly')
      .select(MONTH_COUNT_COL)
      .eq('user_id', 'probe')
      .eq(MONTH_KEY_COL, probeVal)
      .limit(1);

    if (error && (error.code === '42703' || error.code === 'PGRST204') && String(error.message || '').includes('month_key')) {
      MONTH_KEY_COL = 'month';
      console.warn('[probe] usage_monthly missing month_key; falling back to column: month');
    }

    // If the selected count column is wrong/missing, try candidates
    if (error && (error.code === '42703' || error.code === 'PGRST204')) {
      for (const cand of COUNT_CANDIDATES) {
        try {
          const { error: e2 } = await supabase
            .from('usage_monthly')
            .select(cand)
            .eq('user_id', 'probe')
            .eq(MONTH_KEY_COL, probeVal)
            .limit(1);
          if (!e2) {
            MONTH_COUNT_COL = cand;
            console.warn(`[probe] usage_monthly missing count; falling back to column: ${cand}`);
            break;
          }
        } catch {}
      }
    }
  } catch (e) {
    console.warn('[probe] usage_monthly probe exception:', e?.message || e);
  }
}


// Expected tables (recommended):
// users: { id uuid pk, email text unique, password_hash text, plan text, paddle_customer_id text, paddle_subscription_id text, created_at }
// usage_daily:   { user_id uuid/text, date_key text 'YYYY-MM-DD', count int, updated_at } unique(user_id,date_key)
// usage_monthly: { user_id uuid/text, month_key text 'YYYY-MM',  count int, updated_at } unique(user_id,month_key)

async function getDailyCount(userId, dateKey) {
  await probeUsageColumns();
  const { data, error } = await supabase
    .from('usage_daily')
    .select(DAILY_COUNT_COL)
    .eq('user_id', userId)
    .eq(DAILY_KEY_COL, dateKey)
    .maybeSingle();

  if (error) throw error;
  return (data && data[DAILY_COUNT_COL]) ? Number(data[DAILY_COUNT_COL]) : 0;
}


async function getMonthlyCount(userId, monthKey) {
  await probeUsageColumns();
  const { data, error } = await supabase
    .from('usage_monthly')
    .select(MONTH_COUNT_COL)
    .eq('user_id', userId)
    .eq(MONTH_KEY_COL, monthKey)
    .maybeSingle();

  if (error) throw error;
  return (data && data[MONTH_COUNT_COL]) ? Number(data[MONTH_COUNT_COL]) : 0;
}


async function incDaily(userId, dateKey) {
  await probeUsageColumns();

  const { data: existing, error: selErr } = await supabase
    .from('usage_daily')
    .select(DAILY_COUNT_COL)
    .eq('user_id', userId)
    .eq(DAILY_KEY_COL, dateKey)
    .maybeSingle();

  if (selErr) throw selErr;

  const current = existing ? Number(existing[DAILY_COUNT_COL] ?? 0) : 0;
  const next = current + 1;

  const payload = { user_id: userId, [DAILY_COUNT_COL]: next, [DAILY_KEY_COL]: dateKey };
  const { error: upErr } = await supabase
    .from('usage_daily')
    .upsert(payload, { onConflict: `user_id,${DAILY_KEY_COL}` });

  if (upErr) throw upErr;
  return next;
}


async function incMonthly(userId, monthKey) {
  await probeUsageColumns();

  const { data: existing, error: selErr } = await supabase
    .from('usage_monthly')
    .select(MONTH_COUNT_COL)
    .eq('user_id', userId)
    .eq(MONTH_KEY_COL, monthKey)
    .maybeSingle();

  if (selErr) throw selErr;

  const current = existing ? Number(existing[MONTH_COUNT_COL] ?? 0) : 0;
  const next = current + 1;

  const payload = { user_id: userId, [MONTH_COUNT_COL]: next, [MONTH_KEY_COL]: monthKey };
  const { error: upErr } = await supabase
    .from('usage_monthly')
    .upsert(payload, { onConflict: `user_id,${MONTH_KEY_COL}` });

  if (upErr) throw upErr;
  return next;
}


// ---------- TIME HELPERS (Thailand) ----------
function toBangkokDate(d = new Date()) {
  return new Date(d.toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
}
function thaiDateKey(d = new Date()) {
  const dt = toBangkokDate(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function thaiMonthKey(d = new Date()) {
  const dt = toBangkokDate(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// ---------- AUTH ----------
function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, plan: user.plan },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function authRequired(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "unauthorized", message: "กรุณา Login" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (e) {
    return res.status(401).json({ error: "unauthorized", message: "Token ไม่ถูกต้อง/หมดอายุ" });
  }
}

// Always read latest plan from DB so webhook upgrades apply immediately
async function hydrateUserPlan(req, res, next) {
  try {
    const email = String(req.user?.email || "").toLowerCase();
    if (!email) {
      req.user.plan = String(req.user?.plan || "free").toLowerCase();
      return next();
    }
    const { data, error } = await supabase
      .from("users")
      .select("plan")
      .eq("email", email)
      .maybeSingle();
    if (!error && data?.plan) req.user.plan = String(data.plan).toLowerCase();
  } catch (_) {
    // ignore
  }
  req.user.plan = String(req.user?.plan || "free").toLowerCase();
  next();
}

// ---------- QUOTA ----------
const LIMITS = {
  freeDaily: 20,
  basicMonthly: 300,
}

function nextThaiMidnightIso() {
  const dt = toBangkokDate(new Date());
  dt.setHours(24, 0, 0, 0); // next midnight in Bangkok "wall clock"
  return dt.toISOString();
}
function nextThaiMonthIso() {
  const dt = toBangkokDate(new Date());
  dt.setDate(1);
  dt.setHours(0, 0, 0, 0);
  dt.setMonth(dt.getMonth() + 1); // first day next month 00:00 Bangkok
  return dt.toISOString();
}
function usageSummary(plan, usage) {
  const p = String(plan || "free").toLowerCase();
  const u = usage || {};
  const usedToday = Number(u.usedToday || 0);
  const usedMonth = Number(u.usedMonth || 0);

  if (p === "pro") {
    return {
      plan: "pro",
      window: "unlimited",
      limit: null,
      used: null,
      remaining: null,
      resetAt: null
    };
  }
  if (p === "basic") {
    const limit = LIMITS.basicMonthly;
    const remaining = Math.max(0, limit - usedMonth);
    return {
      plan: "basic",
      window: "monthly",
      limit,
      used: usedMonth,
      remaining,
      resetAt: nextThaiMonthIso()
    };
  }
  // default FREE
  const limit = LIMITS.freeDaily;
  const remaining = Math.max(0, limit - usedToday);
  return {
    plan: "free",
    window: "daily",
    limit,
    used: usedToday,
    remaining,
    resetAt: nextThaiMidnightIso()
  };
}
;

function quotaGuard() {
  return async (req, res, next) => {
    try {
      const userId = req.user.id;
      const plan = String(req.user.plan || "free").toLowerCase();

      const dateKey = thaiDateKey();
      const monthKey = thaiMonthKey();

      const usedToday = await getDailyCount(userId, dateKey);
      const usedMonth = await getMonthlyCount(userId, monthKey);

      console.log({ user: req.user.email, plan, usedToday, usedMonth, dateKey, monthKey });

      // PRO: unlimited
      if (plan === "pro") {
        req.usage = { usedToday, usedMonth, dateKey, monthKey };
        return next();
      }

      // FREE: 20/day
      if (plan === "free") {
        if (usedToday >= LIMITS.freeDaily) {
          const usage = { usedToday, usedMonth, dateKey, monthKey };
          return res.status(402).json({
            error: "quota_exceeded",
            message: `ใช้โควตาครบแล้ว (${LIMITS.freeDaily} ครั้ง/วัน) กรุณาอัปเกรดแพ็กเกจ`,
            plan,
            usage,
            usageSummary: usageSummary(plan, usage),
            requestId: req.requestId || null
          });
        }
        req.usage = { usedToday, usedMonth, dateKey, monthKey };
        return next();
      }

      // BASIC: 300/month
      if (plan === "basic") {
        if (usedMonth >= LIMITS.basicMonthly) {
          const usage = { usedToday, usedMonth, dateKey, monthKey };
          return res.status(402).json({
            error: "quota_exceeded",
            message: `ใช้โควตาครบแล้ว (${LIMITS.basicMonthly} ครั้ง/เดือน) กรุณาอัปเกรดแพ็กเกจ`,
            plan,
            usage,
            usageSummary: usageSummary(plan, usage),
            requestId: req.requestId || null
          });
        }
        req.usage = { usedToday, usedMonth, dateKey, monthKey };
        return next();
      }

      // unknown plan -> treat as free
      if (usedToday >= LIMITS.freeDaily) {
        return res.status(402).json({
          error: "quota_exceeded",
          message: `ใช้โควตาครบแล้ว (${LIMITS.freeDaily} ครั้ง/วัน) กรุณาอัปเกรดแพ็กเกจ`,
          plan: "free",
          usage: { usedToday, usedMonth, dateKey, monthKey },
        });
      }
      req.usage = { usedToday, usedMonth, dateKey, monthKey };
      return next();
    } catch (err) {
      console.error("quotaGuard error", err);
      return res.status(500).json({ error: "internal_error", message: "ระบบขัดข้อง" });
    }
  };
}

async function bumpUsage(userId) {
  const dateKey = thaiDateKey();
  const monthKey = thaiMonthKey();

  await incDaily(userId, dateKey);
  await incMonthly(userId, monthKey);

  const usedToday = await getDailyCount(userId, dateKey);
  const usedMonth = await getMonthlyCount(userId, monthKey);

  return { usedToday, usedMonth, dateKey, monthKey };
}

// ---------- GEMINI ----------
// =============================
// Gemini (Text) - REST client (supports v1 + v1beta) with model fallback
// =============================
function normalizeGeminiModelName(name) {
  if (!name) return "";
  let s = String(name).trim();
  if (s.startsWith("models/")) s = s.slice("models/".length);
  if (s.includes("/")) s = s.split("/").pop();
  return s;
}

function uniqueNonEmpty(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const v = (x || "").trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function isUpstreamRateLimited(err) {
  const status = Number(err?.status || err?.statusCode || 0);
  if (status === 429) return true;
  const msg = String(err?.message || "");
  return /rate limit|too many requests|quota/i.test(msg);
}

function isModelNotFound(err) {
  const status = Number(err?.status || err?.statusCode || 0);
  if (status === 404) return true;
  const msg = String(err?.message || "");
  return /model.*not found/i.test(msg) || /404\s+not found/i.test(msg);
}

async function callGeminiGenerateContent({ prompt, temperature = 0.6, maxOutputTokens = 1024, responseMimeType }) {
  if (!GEMINI_API_KEY) {
    const err = new Error("Missing GEMINI_API_KEY");
    err.status = 500;
    throw err;
  }

  const envModel = normalizeGeminiModelName(process.env.GEMINI_MODEL || "");
  const modelCandidates = uniqueNonEmpty([
    envModel,
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-flash-latest",
  ]);

  const apiVersions = ["v1", "v1beta"];

  let lastError = null;

  for (const apiVersion of apiVersions) {
    for (const model of modelCandidates) {
      const url =
        `https://generativelanguage.googleapis.com/${apiVersion}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: Object.assign({ temperature, maxOutputTokens }, responseMimeType ? { responseMimeType } : {}),
          }),
        });

        if (resp.status === 429) {
          const err = new Error("Gemini rate limited (429)");
          err.status = 429;
          err.body = await resp.text().catch(() => "");
          throw err;
        }

        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          const err = new Error(`Gemini HTTP ${resp.status} (${apiVersion}/${model})`);
          err.status = resp.status;
          err.body = body;
          lastError = err;
          continue;
        }

        const data = await resp.json();

        const textOut =
          data?.candidates?.[0]?.content?.parts?.map((p) => p?.text).filter(Boolean).join("\n") ||
          data?.candidates?.[0]?.content?.parts?.[0]?.text ||
          "";

        if (!textOut) {
          const err = new Error(`Gemini empty response (${apiVersion}/${model})`);
          err.status = 502;
          err.body = JSON.stringify(data).slice(0, 2000);
          lastError = err;
          continue;
        }

        return { text: textOut, modelUsed: model, apiVersion };
      } catch (e) {
        lastError = e;
        if (e?.status === 429) throw e;
      }
    }
  }

  const err = lastError || new Error("Gemini request failed");
  err.status = err.status || 502;
  throw err;
}

// ------------------------
// Backend JSON normalization helpers
// ------------------------

function stripCodeFences(s = "") {
  const t = String(s || "").trim();
  // Remove markdown code fences if the model returns them.
  if (t.startsWith("```")) {
    return t
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
  }
  return t;
}

function extractFirstJsonBlob(text) {
  const s = stripCodeFences(text);
  // Try to find a JSON object/array in a larger string.
  const objStart = s.indexOf("{");
  const arrStart = s.indexOf("[");
  let start = -1;
  if (objStart === -1) start = arrStart;
  else if (arrStart === -1) start = objStart;
  else start = Math.min(objStart, arrStart);
  if (start === -1) return null;

  // Walk and balance braces/brackets.
  const opening = s[start];
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === opening) depth++;
    if (ch === closing) depth--;
    if (depth === 0) {
      return s.slice(start, i + 1);
    }
  }
  return null;
}

function tryParseJson(text) {
  const blob = extractFirstJsonBlob(text);
  if (!blob) return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(blob) };
  } catch {
    return { ok: false, value: null };
  }
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) return obj[k];
  }
  return undefined;
}

function normalizeTrendItem(raw, idx) {
  const r = raw && typeof raw === "object" ? raw : {};
  const title = String(pickFirst(r, ["title", "trend", "topic", "headline", "name"]) || `Trending #${idx + 1}`).trim();
  const tiktokUrl = String(pickFirst(r, ["tiktokUrl", "url", "link", "tiktok", "openTikTokUrl"]) || "").trim();
  const hook = String(pickFirst(r, ["hook", "theHook", "hook_th", "hook_thai"]) || "").trim();
  const whyViral = String(pickFirst(r, ["why_viral", "whyViral", "analysis", "reason", "why", "whyItsViral"]) || "").trim();
  const contentIdea = String(pickFirst(r, ["contentIdea", "idea", "content", "concept", "howTo", "recommendation"]) || "").trim();
  const imagePrompt = String(pickFirst(r, ["imagePrompt", "prompt", "thumbnailPrompt", "midjourneyPrompt"]) || "").trim();

  return {
    id: idx + 1,
    title,
    tiktokUrl,
    hook,
    why_viral: whyViral,
    contentIdea,
    imagePrompt,
  };
}

function normalizeTrendsPayload(parsed) {
  // Goal: always return { trends: [10 items] } even when the model returns odd JSON shapes.
  // Accept many variants:
  // - {trends:[...]} / {items:[...]} / {results:[...]} / {data:[...]} / {top10:[...]}
  // - {trends:{1:{...},2:{...}}}  (object)
  // - {trend1:{...}, trend2:{...}} or {"1":{...},"2":{...}}
  // - nested containers like {data:{trends:[...]}} or {output:{items:[...]}}
  let list = [];

  const asListFromMaybe = (maybe) => {
    if (!maybe) return null;
    if (Array.isArray(maybe)) return maybe;
    if (typeof maybe === "object") return Object.values(maybe);
    return null;
  };

  const dig = (obj, depth = 0) => {
    if (!obj || typeof obj !== "object" || depth > 2) return null;
    const directKeys = ["trends", "items", "results", "data", "top10", "topTrends", "trending", "topics", "trendList", "list"];
    for (const k of directKeys) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        const got = asListFromMaybe(obj[k]);
        if (got && got.length) return got;
      }
    }
    // If object has keys trend1..trend10 or 1..10, collect in order
    const keys = Object.keys(obj);
    const numeric = keys.filter(k => /^\d+$/.test(k)).sort((a,b)=>Number(a)-Number(b));
    const trendN = keys.filter(k => /^trend\d+$/i.test(k)).sort((a,b)=>Number(a.replace(/\D/g,''))-Number(b.replace(/\D/g,'')));
    if (numeric.length) return numeric.map(k => obj[k]);
    if (trendN.length) return trendN.map(k => obj[k]);
    // Otherwise try one-level nested objects
    for (const k of keys) {
      const child = obj[k];
      const got = dig(child, depth + 1);
      if (got && got.length) return got;
    }
    return null;
  };

  if (Array.isArray(parsed)) list = parsed;
  else list = dig(parsed) || [];

  const slice = list.slice(0, 10);
  const normalized = slice.map((t, i) => normalizeTrendItem(t, i));
  const extractedCount = normalized.filter((it, i) => it.title && it.title !== `Trending #${i + 1}`).length;

  // If fewer than 10, pad with safe placeholders so UI never breaks.
  while (normalized.length < 10) {
    normalized.push(normalizeTrendItem({}, normalized.length));
  }

  return { trends: normalized, _extractedCount: extractedCount };
}


// ------------------------------
// Review JSON "Lock" helpers (v41 production hardened)
// ------------------------------
function normalizeString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  return String(v).trim();
}

function normalizeStringArray(v) {
  if (Array.isArray(v)) return v.map(normalizeString).filter(Boolean);
  if (typeof v === 'string') {
    return v
      .split(/\r?\n|•|\u2022|\-|\*|\d+\)|\d+\.|\u25CF/g)
      .map(s => s.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeReviewPayload(obj) {
  const o = (obj && typeof obj === 'object') ? obj : {};
  let script30s = normalizeString(o.script30s ?? o.script ?? o.script_30s ?? o['30sScript'] ?? o.text ?? o.output ?? '');
  let pov = normalizeString(o.pov ?? o.POV ?? o.concept ?? o['pov_concept'] ?? '');
  let hooks = normalizeStringArray(o.hooks ?? o.Hooks ?? o.hook ?? o.hookList ?? []);
  let values = normalizeStringArray(o.values ?? o.Values ?? o.value ?? o.valueList ?? []);
  let ctas = normalizeStringArray(o.ctas ?? o.CTAs ?? o.cta ?? o.ctaList ?? []);

  // Enforce lengths
  if (hooks.length > 5) hooks = hooks.slice(0, 5);
  if (values.length > 3) values = values.slice(0, 3);
  if (ctas.length > 3) ctas = ctas.slice(0, 3);
  while (hooks.length < 5) hooks.push('');
  while (values.length < 3) values.push('');
  while (ctas.length < 3) ctas.push('');

  // If script is missing but we have other text fields, fallback
  if (!script30s) script30s = normalizeString(o.raw ?? o.result ?? '');

  return { script30s, pov, hooks, values, ctas };
}

function validateReviewPayload(payload) {
  const p = payload || {};
  const errs = [];
  if (!p || typeof p !== 'object') errs.push('payload_not_object');
  if (!normalizeString(p.script30s)) errs.push('missing_script30s');
  if (!Array.isArray(p.hooks) || p.hooks.length !== 5) errs.push('hooks_not_5');
  if (!Array.isArray(p.values) || p.values.length !== 3) errs.push('values_not_3');
  if (!Array.isArray(p.ctas) || p.ctas.length !== 3) errs.push('ctas_not_3');
  return { ok: errs.length === 0, errors: errs };
}

const REVIEW_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    script30s: { type: "string" },
    pov: { type: "string" },
    hooks: { type: "array", items: { type: "string" }, minItems: 5, maxItems: 5 },
    values: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
    ctas: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 }
  },
  required: ["script30s", "pov", "hooks", "values", "ctas"]
};

async function generateLockedReviewJson(model, basePrompt, options = {}) {
  // Two-layer hardening:
  // 1) Ask model for strict JSON (application/json + schema)
  // 2) Validate; if invalid, repair with a second call; if still invalid, return normalized best-effort object
  const temperature = typeof options.temperature === 'number' ? options.temperature : 0.6;
  const maxOutputTokens = typeof options.maxOutputTokens === 'number' ? options.maxOutputTokens : 1200;

  const generationConfig = {
    temperature,
    maxOutputTokens,
    responseMimeType: "application/json",
    responseSchema: REVIEW_RESPONSE_SCHEMA
  };

  const strictPrompt = [
    "OUTPUT MUST BE VALID JSON ONLY.",
    "No markdown fences. No extra keys.",
    "Schema: {script30s:string, pov:string, hooks:[5 strings], values:[3 strings], ctas:[3 strings]}",
    "",
    basePrompt
  ].join("\n");

  let text1 = '';
  try {
    const r1 = await model.generateContent({ contents: [{ role: "user", parts: [{ text: strictPrompt }] }], generationConfig });
    text1 = (r1?.response?.text?.() || '').trim();
  } catch (e) {
    // fall through to repair/normalize
    text1 = '';
  }

  let parsed1 = tryParseJson(text1);
  if (parsed1.ok) {
    const norm = normalizeReviewPayload(parsed1.value);
    const v = validateReviewPayload(norm);
    if (v.ok) return { ok: true, json: norm, rawText: text1, repaired: false };
  }

  // Repair attempt: send original output and ask to fix
  const repairPrompt = [
    "You returned INVALID JSON. Fix it.",
    "Return ONLY valid JSON matching the schema exactly.",
    "No markdown fences. No explanations.",
    "",
    "INVALID_OUTPUT:",
    text1 ? text1.slice(0, 6000) : "(empty)"
  ].join("\n");

  let text2 = '';
  try {
    const r2 = await model.generateContent({ contents: [{ role: "user", parts: [{ text: repairPrompt }] }], generationConfig });
    text2 = (r2?.response?.text?.() || '').trim();
  } catch (e) {
    text2 = '';
  }

  let parsed2 = tryParseJson(text2);
  if (parsed2.ok) {
    const norm = normalizeReviewPayload(parsed2.value);
    const v = validateReviewPayload(norm);
    if (v.ok) return { ok: true, json: norm, rawText: text2, repaired: true };
  }

  // Final fallback: best-effort normalization (never crash the frontend)
  const fallbackObj = normalizeReviewPayload(parsed1.ok ? parsed1.value : {});
  if (!fallbackObj.script30s) fallbackObj.script30s = normalizeString(text1 || text2 || basePrompt);
  const v3 = validateReviewPayload(fallbackObj);
  return { ok: v3.ok, json: fallbackObj, rawText: text1 || text2, repaired: true, fallback: true, errors: v3.errors };
}


function looksLikeTrendsPayload(obj) {
  return !!(obj && typeof obj === "object" && Array.isArray(obj.trends));
}

app.post("/api/gemini-text", authRequired, hydrateUserPlan, quotaGuard(), async (req, res) => {
  try {
    const { prompt, responseMimeType, useSearch, temperature, maxOutputTokens, meta } = req.body || {};

    const requestId = req.requestId || (crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)));
const { cacheKey, cacheTtlSec } = (req.body || {});
if (cacheKey) {
  const cached = cacheGet(String(cacheKey));
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    const usage = await bumpUsage(req.user.id);
    return res.json({ ...cached, requestId, cached: true, plan: String(req.user.plan||"free").toLowerCase(), usage, usageSummary: usageSummary(req.user.plan, usage) });
  }
  res.setHeader("X-Cache", "MISS");
}

    if (!prompt) return res.status(400).json({ error: "prompt_required" });

    const mimeRequested = responseMimeType ? String(responseMimeType) : undefined;

    // Viral Finder MUST be stable: always return exactly 10 trends.
    // Even if the frontend forgets to request JSON, force JSON mode for Viral Finder.
    // The frontend can also set explicit flags (forceTrends / viralCategory / category).
    const promptText = String(prompt);
    const forceTrends = !!req.body.forceTrends;
    const viralCategory = req.body.viralCategory || req.body.category || (meta && meta.viralCategory);
    const wantsTrends = (
      forceTrends ||
      !!viralCategory ||
      (meta && typeof meta === "object" && meta.tool === "viral_finder_trends") ||
      /viral\s*f\w*nder|viral\s*finder|trending\s*1-?10|\"trends\"\s*:|\btrends\b/i.test(promptText)
    );

    const effectiveMime = wantsTrends ? "application/json" : mimeRequested;
    const wantsJson = effectiveMime === "application/json";

    const VIRAL_STRICT_JSON_PREFIX = `You are a JSON API. Return ONLY valid JSON. No markdown, no commentary.

Schema (MUST follow exactly):
{
  "category": string,
  "trends": [
    {
      "rank": 1,
      "title": string,
      "hook": string,
      "reason": string,
      "idea": string,
      "prompt": string,
      "tiktokUrl": string
    }
  ]
}

Rules:
- "trends" MUST be an array with EXACTLY 10 items (rank 1..10). No fewer, no more.
- Each title MUST be a distinct TikTok trend/topic for the requested category. Avoid duplicates.
- tiktokUrl MUST be a valid-looking TikTok URL (https://www.tiktok.com/...) relevant to the title. If you are unsure, still provide a plausible TikTok search URL format.
- Keep hook/reason/idea/prompt concise (1-2 lines each).
`;

    const finalPrompt = wantsTrends
      ? `${VIRAL_STRICT_JSON_PREFIX}\n\nUSER_REQUEST:\n${promptText}`
      : promptText;

    const runOnce = async (p) => {
      return await callGeminiGenerateContent({
        prompt: p,
        useSearch: wantsTrends ? true : !!useSearch,
        responseMimeType: effectiveMime,
        temperature: (typeof temperature === "number" ? temperature : (wantsJson ? 0.4 : 0.6)),
        maxOutputTokens: 2048,
      });
    };

    let { text: aiText, modelUsed, apiVersion } = await runOnce(finalPrompt);
    let finalText = aiText;

    if (wantsJson) {
      // Try parse JSON response; if parsing fails, still return raw text.
      try {
        const json = JSON.parse(finalText);
        const usage = await bumpUsage(req.user.id);
        return res.json({ ok: true, json, requestId, plan: String(req.user.plan||"free").toLowerCase(), usage, usageSummary: usageSummary(req.user.plan, usage) });
      } catch (e) {
        const usage = await bumpUsage(req.user.id);
        return res.json({ ok: true, text: finalText, requestId, json_parse_error: String(e && e.message ? e.message : e) , plan: String(req.user.plan||"free").toLowerCase(), usage, usageSummary: usageSummary(req.user.plan, usage) });
      }
    }

    const hookPrompt = [
      "You are a video editor assistant.",
      "Given a short transcript, estimate the best hook segment for a short-form video.",
      "Return ONLY valid JSON with keys: hookStart (number, seconds), hookDuration (number, seconds), rationale (string).",
      "Rules:",
      "- hookStart must be >= 0",
      "- hookDuration between 2 and 6",
      "- Keep rationale short.",
      "",
      `Language hint: ${language}`,
      "",
      "Transcript:",
      safeTranscript
    ].join("\n");

    // Ask Gemini for strict JSON
    const out = await callGeminiGenerateContent({
      prompt: hookPrompt.join("\n"),
      temperature: 0.3,
      maxOutputTokens: 256,
      responseMimeType: "application/json",
    });

    let jsonText = (out && out.text) ? String(out.text) : "";
    // Gemini sometimes wraps JSON in code fences
    jsonText = jsonText.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      // fallback - try to extract first JSON object
      const match = jsonText.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : null;
    }

    // count usage once per request (even if output is invalid)
    const usage = await bumpUsage(req.user.id);

    if (!parsed || typeof parsed !== "object") {
      return res.json({
        plan: String(req.user.plan || "free").toLowerCase(),
        usage,
        usageSummary: usageSummary(req.user.plan, usage),
        hookStart: 0,
        hookDuration: 3,
        rationale: "Fallback (invalid model output)"
      });
    }

    const hookStart = Number(parsed.hookStart);
    const hookDuration = Number(parsed.hookDuration);

    return res.json({
      plan: String(req.user.plan||"free").toLowerCase(),
      usage,
      usageSummary: usageSummary(req.user.plan, usage),
      hookStart: Number.isFinite(hookStart) ? Math.max(0, hookStart) : 0,
      hookDuration: Number.isFinite(hookDuration) ? Math.min(6, Math.max(2, hookDuration)) : 3,
      rationale: String(parsed.rationale || "")
    });
  } catch (err) {
    console.error("geminiHook error:", err);
    return res.status(err.status || 500).json({ error: err.message || "geminiHook failed" });
  }
});

app.post("/api/logUsage", async (req, res) => {
  try {
    // Keep compatible with the old Netlify function signature
    const { user, action, meta } = req.body || {};
    console.log("[logUsage]", { user, action, meta });
    return res.json({ ok: true });
  } catch (err) {
    console.error("logUsage error:", err);
    return res.status(500).json({ ok: false });
  }
});




// ---------- AUTH ROUTES (email+password -> JWT) ----------
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email_and_password_required' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    // check exist
    const { data: existing, error: existingErr } = await supabase
      .from('users')
      .select('id')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (existingErr) throw existingErr;
    if (existing) {
      return res.status(409).json({ error: 'email_already_registered' });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const { data: newUser, error: insertErr } = await supabase
      .from('users')
      .insert({
        email: normalizedEmail,
        password_hash,
        plan: 'free'
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    const token = signToken(newUser);

    res.json({
      token,
      user: {
        id: newUser.id,
        email: newUser.email,
        plan: newUser.plan
      }
    });
  } catch (err) {
    console.error('register error', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email_and_password_required' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', normalizedEmail)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const token = signToken(user);

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        plan: user.plan
      }
    });
  } catch (err) {
    console.error('login error', err);
    res.status(500).json({ error: 'internal_error' });
  }
});
// ---------- PADDLE CHECKOUT ----------
const PRICE_TO_PLAN = {
  [PADDLE_BASIC_PRICE_ID]: "basic",
  [PADDLE_PRO_PRICE_ID]: "pro",
};

function paddleApiBase() {
  const explicit = (process.env.PADDLE_API_BASE || "").trim();
  if (explicit) return explicit;

  const env = (process.env.PADDLE_ENV || "sandbox").toLowerCase();
  const keyRaw = process.env.PADDLE_API_KEY || "";
  const key = cleanHeaderValue(keyRaw).toLowerCase();

  // Heuristic: if the key clearly looks like a live key, prefer production;
  // if it looks like a test/sandbox key, prefer sandbox.
  const looksLive = key.includes("_live_") || key.startsWith("pdl_live") || key.startsWith("pdI_live") || key.startsWith("pdi_live");
  const looksSandbox = key.includes("_test_") || key.includes("_sandbox_") || key.startsWith("pdl_test") || key.startsWith("pdl_sandbox") || key.startsWith("pdi_test");

  if (looksLive) return "https://api.paddle.com";
  if (looksSandbox) return "https://sandbox-api.paddle.com";

  return env === "production" ? "https://api.paddle.com" : "https://sandbox-api.paddle.com";
}



function normalizeRedirectUrl(url) {
  // Paddle rejects URLs with hash fragments (#...). Convert them to query param `paddle_return`.
  // Example: https://site.app/#pricing?success=1 -> https://site.app/?paddle_return=pricing%3Fsuccess%3D1
  if (!url || typeof url !== "string") return "";
  const raw = url.trim();
  if (!raw) return "";
  if (!raw.includes("#")) return raw;

  const [baseWithQuery, fragRaw = ""] = raw.split("#");
  const [baseNoQuery, baseQuery = ""] = baseWithQuery.split("?");
  const base = baseNoQuery.replace(/\/$/, "");

  const frag = fragRaw.replace(/^\//, ""); // drop leading "/"
  const qp = new URLSearchParams(baseQuery);
  if (frag) qp.set("paddle_return", frag);

  const qs = qp.toString();
  return qs ? `${base}/?${qs}` : `${base}/`;
}

function safeUrl(url, name) {
  try {
    return new URL(url).toString();
  } catch (e) {
    throw new Error(`Invalid ${name}: ${url}`);
  }
}

/**
 * Paddle sometimes rejects URLs with fragments (#...).
 * We keep the intended fragment by moving it into a query param `paddle_hash`,
 * then the frontend can restore location.hash if desired.
 */
function normalizeCheckoutUrlForPaddle(urlStr) {
  // Paddle validates these URLs and often rejects fragments (#...).
  // For hash routers like `/#pricing?success=1`, we:
  //   - move the hash route into `paddle_return`
  //   - merge any hash query (?a=1) into the real querystring
  //   - strip the fragment entirely
  const u = new URL(urlStr);

  if (u.hash && u.hash.length > 1) {
    const fragRaw = u.hash.slice(1); // remove '#'
    const [fragRoute, fragQuery] = fragRaw.split("?", 2);

    if (fragRoute) u.searchParams.set("paddle_return", fragRoute);

    if (fragQuery) {
      const qp = new URLSearchParams(fragQuery);
      for (const [k, v] of qp.entries()) u.searchParams.set(k, v);
    }
    u.hash = "";
  }

  return u.toString();
}


// ---------- USER / USAGE (Soft gate support) ----------
app.get("/api/user", authRequired, hydrateUserPlan, async (req, res) => {
  try {
    const userId = req.user.id;
    const plan = String(req.user.plan || "free").toLowerCase();
    const dateKey = thaiDateKey();
    const monthKey = thaiMonthKey();
    const usedToday = await getDailyCount(userId, dateKey);
    const usedMonth = await getMonthlyCount(userId, monthKey);
    const usage = { usedToday, usedMonth, dateKey, monthKey };
    return res.json({
      ok: true,
      user: { id: userId, email: req.user.email, plan },
      limits: LIMITS,
      usage,
      usageSummary: usageSummary(plan, usage),
      requestId: req.requestId || null
    });
  } catch (err) {
    console.error("GET /api/user error", err);
    return res.status(500).json({ ok: false, error: "internal_error", requestId: req.requestId || null });
  }
});

app.get("/api/usage", authRequired, hydrateUserPlan, async (req, res) => {
  try {
    const userId = req.user.id;
    const plan = String(req.user.plan || "free").toLowerCase();
    const dateKey = thaiDateKey();
    const monthKey = thaiMonthKey();
    const usedToday = await getDailyCount(userId, dateKey);
    const usedMonth = await getMonthlyCount(userId, monthKey);
    const usage = { usedToday, usedMonth, dateKey, monthKey };
    return res.json({
      ok: true,
      plan,
      limits: LIMITS,
      usage,
      usageSummary: usageSummary(plan, usage),
      requestId: req.requestId || null
    });
  } catch (err) {
    console.error("GET /api/usage error", err);
    return res.status(500).json({ ok: false, error: "internal_error", requestId: req.requestId || null });
  }
});
// ---------- /USER / USAGE ----------

app.post("/api/paddle/create-checkout", authRequired, async (req, res) => {
  // Expected body: { plan: "basic" | "pro" }
  try {
    const plan = String(req.body?.plan || "").toLowerCase();

    const resolvePriceId = (k) => {
      if (k === "basic") return process.env.PADDLE_BASIC_PRICE_ID || process.env.PADDLE_PRICE_ID_BASIC;
      if (k === "pro") return process.env.PADDLE_PRO_PRICE_ID || process.env.PADDLE_PRICE_ID_PRO;
      return null;
    };

    const priceId = (resolvePriceId(plan) || "").trim();
    if (!priceId) {
      return res.status(400).json({ error: "missing_price_id", message: `Missing price id for plan: ${plan}` });
    }

    const apiKeyRaw = process.env.PADDLE_API_KEY || process.env.PADDLE_APIKEY || "";
    const apiKey = cleanHeaderValue(apiKeyRaw);
    if (!apiKey) {
      return res.status(500).json({ error: "missing_paddle_key", message: "PADDLE_API_KEY is not configured" });
    }

    // NOTE: Paddle is strict about redirect URLs.
    // - Must be absolute https URL
    // - Should not contain fragments (#...)
    // - Some accounts require whitelisting these URLs in Paddle settings.
    const successUrlRaw = String(process.env.CHECKOUT_SUCCESS_URL || "").trim();
    const cancelUrlRaw = String(process.env.CHECKOUT_CANCEL_URL || "").trim();

    const successUrl = sanitizeRedirectUrl(successUrlRaw);
    const cancelUrl = sanitizeRedirectUrl(cancelUrlRaw);

    if (!successUrl || !cancelUrl) {
      return res.status(500).json({
        error: "missing_checkout_urls",
        message: "CHECKOUT_SUCCESS_URL / CHECKOUT_CANCEL_URL are not configured (or invalid)",
        sent: { successUrlRaw, cancelUrlRaw },
      });
    }

    // Validate they're absolute URLs
    try {
      new URL(successUrl);
      new URL(cancelUrl);
    } catch {
      return res.status(400).json({
        error: "invalid_checkout_urls",
        message: "CHECKOUT_SUCCESS_URL / CHECKOUT_CANCEL_URL must be absolute URLs (https://...)",
        sent: { successUrl, cancelUrl },
      });
    }

    const apiBase = paddleApiBase();
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    // Paddle Billing (API v2) — best effort:
    // Prefer /transactions (modern) which returns checkout.url
    const endpoint = "/transactions";

    const payload = {
      items: [{ price_id: priceId, quantity: 1 }],
      customer: { email: req.user?.email || undefined },
      checkout: {
        success_url: successUrl,
        cancel_url: cancelUrl,
      },
      // helpful metadata for debugging / customer support
      custom_data: {
        plan,
        user_id: req.user?.id || null,
        email: req.user?.email || null,
      },
    };

    const requestId = crypto.randomUUID();

    const r = await axios.post(`${apiBase}${endpoint}`, payload, {
      headers,
      timeout: 20000,
      validateStatus: () => true, // we'll handle errors explicitly
    });

    // Success path
    const checkoutUrl =
      r?.data?.data?.checkout?.url ||
      r?.data?.data?.checkout_url ||
      r?.data?.checkout?.url ||
      r?.data?.url ||
      null;

    if (r.status >= 200 && r.status < 300 && checkoutUrl) {
      return res.json({
        url: checkoutUrl,
        requestId,
        used: { endpoint, apiBase },
      });
    }

    // Paddle sometimes returns 404 with code "invalid_url" if success/cancel URLs are not allowed.
    const errCode = r?.data?.error?.code || r?.data?.error?.type || r?.data?.code;
    if (r.status === 404 && String(errCode || "").toLowerCase().includes("invalid_url")) {
      return res.status(400).json({
        error: "paddle_invalid_url",
        message:
          "Paddle rejected the success/cancel URL (invalid_url). Ensure the URLs are https, contain no '#', and are allowed/whitelisted in your Paddle dashboard settings.",
        requestId,
        sent: { successUrl, cancelUrl },
        paddle: { status: r.status, error: r.data?.error || r.data },
      });
    }

    // Generic error
    console.error("create-checkout error", {
      requestId,
      lastError: {
        endpoint,
        status: r.status,
        code: errCode,
        response: r?.data,
      },
      sent: {
        plan,
        priceId,
        successUrl,
        cancelUrl,
      },
    });

    return res.status(502).json({
      error: "create_checkout_failed",
      message: "Failed to create checkout session",
      requestId,
      details: {
        endpoint,
        status: r.status,
        code: errCode,
        // keep response small but useful
        paddleError: r?.data?.error || null,
      },
    });
  } catch (err) {
    const requestId = crypto.randomUUID();
    console.error("create-checkout exception", { requestId, message: err?.message, stack: err?.stack });
    return res.status(502).json({ error: "create_checkout_failed", requestId, message: err?.message || String(err) });
  }
});

app.post("/api/paddle/webhook", express.raw({ type: "*/*" }), async (req, res) => {
  try {
    if (!verifyPaddleSignature(req)) {
      return res.status(401).send("invalid signature");
    }

    const json = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body));
    const type = json.event_type || json.type;

    console.log("Paddle webhook:", type);

    const data = json.data || {};
    const customerEmail =
      data.customer?.email ||
      data.customer_email ||
      data?.checkout?.customer?.email;

    const email = customerEmail ? String(customerEmail).toLowerCase() : null;

    const subscriptionId = data.id || data.subscription_id || data.subscription?.id || null;
    const customerId = data.customer?.id || data.customer_id || null;

    const priceId =
      data.items?.[0]?.price?.id ||
      data.items?.[0]?.price_id ||
      data?.transaction?.items?.[0]?.price?.id ||
      data?.transaction?.items?.[0]?.price_id ||
      null;

    const plan = priceId ? PRICE_TO_PLAN[priceId] : null;

    const isActive =
      type === "subscription.activated" ||
      type === "subscription.created" ||
      type === "subscription.updated" ||
      type === "transaction.completed";

    const isCanceled =
      type === "subscription.canceled" ||
      type === "subscription.cancelled" ||
      type === "subscription.paused" ||
      type === "subscription.payment_failed";

    if (email && isActive && plan) {
      const { error } = await supabase
        .from("users")
        .upsert(
          {
            email,
            plan,
            paddle_customer_id: customerId,
            paddle_subscription_id: subscriptionId,
          },
          { onConflict: "email" }
        );
      if (error) console.error("supabase webhook upsert error", error);
      else console.log("✅ User upgraded:", email, "->", plan);
    }

    if (email && isCanceled) {
      const { error } = await supabase
        .from("users")
        .upsert(
          {
            email,
            plan: "free",
            paddle_customer_id: customerId,
            paddle_subscription_id: subscriptionId,
          },
          { onConflict: "email" }
        );
      if (error) console.error("supabase webhook cancel error", error);
      else console.log("↩️ User downgraded:", email, "-> free");
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("webhook error", err);
    return res.status(500).send("error");
  }
});

// ---------- START ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ AutoLife backend listening on http://localhost:${PORT}`);
});