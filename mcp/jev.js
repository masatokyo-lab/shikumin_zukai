// Jev (TypeSafe AI System One) client.
//
// Wire format confirmed from the reference implementation codaaiteam/jev-mcp:
//   POST {JEV_BASE_URL}  Authorization: Bearer <key>
//   body     { model, state, questions: { <name>: { type, instructions, criteria? } } }
//   response { model, answers: { <name>: {...} }, usage }
// Answer shapes: choice -> { choice, confidence }, score -> { score }, noul -> { noul }.

const BASE_URL = process.env.JEV_BASE_URL || "https://api.typesafe.ai/v1/systemone";
const MODEL = process.env.JEV_MODEL || "jev-latest";
const API_KEY =
  process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || process.env.JEV_KEY || "";
const TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS || 20000);

// stub mode keeps the whole loop runnable without a key. Every record it
// produces is tagged mode:"stub" so no scoreboard can pass it off as a judgment.
export const MODE = API_KEY ? "live" : "stub";

export function describeClient() {
  return { mode: MODE, model: MODEL, base_url: BASE_URL, key_present: Boolean(API_KEY) };
}

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function stubAnswer(state, name, question) {
  const r = hash32(`${name}::${question.instructions}::${state.length}::${state.slice(0, 512)}`);
  if (question.type === "noul") return { noul: Number((0.35 + r * 0.55).toFixed(3)) };
  if (question.type === "score") {
    const levels = Array.isArray(question.criteria) ? question.criteria.length : 4;
    return { score: Number((r * (levels - 1)).toFixed(2)) };
  }
  const keys = Object.keys(question.criteria || { unknown: "" });
  return {
    choice: keys[Math.floor(r * keys.length) % keys.length],
    confidence: Number((0.4 + r * 0.5).toFixed(3)),
  };
}

async function callStub(state, questions) {
  const answers = {};
  for (const [name, q] of Object.entries(questions)) answers[name] = stubAnswer(state, name, q);
  return { model: `${MODEL}#stub`, answers, usage: { stub: true } };
}

async function callLive(state, questions) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(BASE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, state, questions }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(
      e?.name === "AbortError"
        ? `Jev request timed out after ${TIMEOUT_MS}ms.`
        : `Could not reach Jev at ${BASE_URL}: ${e.message}`
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Jev API error ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

export async function callJev(state, questions) {
  const started = Date.now();
  const data = MODE === "live" ? await callLive(state, questions) : await callStub(state, questions);
  return {
    mode: MODE,
    model: data.model || MODEL,
    answers: data.answers || {},
    usage: data.usage || null,
    latency_ms: Date.now() - started,
  };
}

// Jev documents `score` as a position on the ordered scale but does not pin down
// whether the index is 0-based or 1-based, so normalise defensively and keep all
// thresholds in 0..1 terms. Verify against a live key before trusting the edges.
export function normalizeScore(raw, levelCount) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || levelCount < 2) return null;
  const span = levelCount - 1;
  const zeroBased = raw / span;
  if (zeroBased >= 0 && zeroBased <= 1) return Number(zeroBased.toFixed(3));
  const oneBased = (raw - 1) / span;
  return Number(Math.min(1, Math.max(0, oneBased)).toFixed(3));
}
