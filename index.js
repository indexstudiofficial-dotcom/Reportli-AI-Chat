// ============================================================
// REPORTLI AI — AI CO-FOUNDER CHAT WORKER (FIXED)
// ============================================================
//
// FLOW:
//   User -> Worker -> CLASSIFIER AI
//     NO_WORK   -> save classifier reply
//     NEED_WORK -> fetch Supabase data -> ANALYST AI -> save reply
//
// REQUEST:
//   { id, user_id, application_id, question }
//
// REQUIRED WORKER SECRETS:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   SARVAM_API_KEY
//
// ============================================================

const SARVAM_URL = "https://api.sarvam.ai/v1/chat/completions";
const SARVAM_MODEL = "sarvam-105b";

// Set to false once everything works to hide internal errors from clients.
const DEBUG = true;


// ============================================================
// HELPERS
// ============================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(),
  });
}

function truncate(value, max = 200) {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return s.length > max ? s.slice(0, max) + "…" : s;
}


// ============================================================
// SUPABASE
// ============================================================

async function supabaseRequest(env, path, options = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY secret.");
  }

  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status} on ${path.split("?")[0]}: ${truncate(data, 300)}`
    );
  }

  return data;
}

// chat_messages uses `id` (NOT message_id)
async function saveReply(env, messageId, reply) {
  if (!messageId) return false;

  try {
    await supabaseRequest(
      env,
      `chat_messages?id=eq.${encodeURIComponent(messageId)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ reply: String(reply || "") }),
      }
    );
    return true;
  } catch (error) {
    console.error("SAVE REPLY ERROR:", error);
    return false;
  }
}

// Verifies application_id + user_id so one user can't read another's data.
// select=* avoids failures from guessed column names.
async function verifyApplication(env, applicationId, userId) {
  const applications = await supabaseRequest(
    env,
    `applications?id=eq.${encodeURIComponent(applicationId)}` +
      `&user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`
  );

  if (!Array.isArray(applications) || applications.length === 0) {
    return null;
  }

  return applications[0];
}


// ============================================================
// PROMPTS
// ============================================================

const CLASSIFIER_SYSTEM_PROMPT = `
You are Reportli AI's classifier.

Decide if the user's question needs SaaS data.

NO_WORK = normal conversation, greetings, casual questions, or general help.
NEED_WORK = questions requiring sessions, events, errors, trends, or SaaS activity.

For NO_WORK, generate a short natural reply.
For NEED_WORK, return null.

Never invent data, customers, revenue, or percentages.
Never treat sessions as unique customers.
Analytics data covers the last 7 days.

Return ONLY valid JSON, no markdown, no explanation:

NO_WORK:
{"classification":"NO_WORK","reply":"..."}

NEED_WORK:
{"classification":"NEED_WORK","reply":null}
`;

const ANALYST_SYSTEM_PROMPT = `
You are Reportli AI, an AI co-founder for SaaS founders.

Answer the founder's question using ONLY the supplied data.

Rules:
- Never invent numbers, customers, revenue, percentages, or data.
- Sessions are NOT unique customers.
- user_activity contains sessions and events.
- Data covers only the last 7 days.
- If data is insufficient or unavailable, say so.
- If data_warnings is non-empty, mention that some data could not be loaded.
- Give concise, useful, founder-level insights.
- Explain why identified problems matter.
- Give a practical next step when useful.
- Never mention Sarvam, Cloudflare, SQL, or the Worker.
- Write naturally and keep responses short.
- Do not output your reasoning, only the final answer.
`;


// ============================================================
// SARVAM
// ============================================================

// Removes reasoning blocks that reasoning models sometimes put in content.
function stripThinking(text) {
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "") // unclosed think block
    .trim();
}

async function sarvamFetch(env, payload) {
  const response = await fetch(SARVAM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": env.SARVAM_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();

  let result = null;
  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    result = null;
  }

  return { response, text, result };
}

async function callSarvam(env, systemPrompt, userContent, maxTokens = 1500) {
  if (!env.SARVAM_API_KEY) {
    throw new Error("Missing SARVAM_API_KEY secret.");
  }

  const payload = {
    model: SARVAM_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    reasoning_effort: "low",
    temperature: 0.2,
    max_tokens: maxTokens,
  };

  let { response, text, result } = await sarvamFetch(env, payload);

  // If the API rejects reasoning_effort, retry once without it.
  if (
    (response.status === 400 || response.status === 422) &&
    /reasoning/i.test(text)
  ) {
    delete payload.reasoning_effort;
    ({ response, text, result } = await sarvamFetch(env, payload));
  }

  if (!response.ok) {
    throw new Error(`Sarvam ${response.status}: ${truncate(text, 300)}`);
  }

  const choice = result?.choices?.[0];
  const content = stripThinking(choice?.message?.content || "");

  if (!content) {
    throw new Error(
      `AI returned an empty response (finish_reason: ${
        choice?.finish_reason || "unknown"
      }). Raw: ${truncate(text, 300)}`
    );
  }

  return content;
}


// ============================================================
// CLASSIFIER
// ============================================================
//
// Never throws on bad model output. If the classifier is unclear,
// we fall back to NEED_WORK so the user still gets a real answer.
// ============================================================

async function classifyQuestion(env, question) {
  const raw = await callSarvam(env, CLASSIFIER_SYSTEM_PROMPT, question, 1500);

  // Grab the first {...} block, ignoring markdown fences or extra text.
  const match = raw.match(/\{[\s\S]*\}/);

  if (!match) {
    console.error("CLASSIFIER NON-JSON:", truncate(raw, 300));
    return { classification: "NEED_WORK", reply: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    console.error("CLASSIFIER BAD JSON:", truncate(raw, 300));
    return { classification: "NEED_WORK", reply: null };
  }

  const classification = String(parsed?.classification || "")
    .trim()
    .toUpperCase();

  if (classification === "NO_WORK") {
    if (typeof parsed.reply === "string" && parsed.reply.trim()) {
      return { classification: "NO_WORK", reply: parsed.reply.trim() };
    }
    return { classification: "NEED_WORK", reply: null };
  }

  return { classification: "NEED_WORK", reply: null };
}


// ============================================================
// ANALYTICS DATA (LAST 7 DAYS)
// ============================================================

async function getAnalyticsData(env, application) {
  const now = new Date();
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const until = now.toISOString();

  const apiKey = encodeURIComponent(application.api_key);
  const warnings = [];

  // ---------- user_activity ----------
  let activity = [];
  try {
    const rows = await supabaseRequest(
      env,
      `user_activity?api_key=eq.${apiKey}` +
        `&time=gte.${encodeURIComponent(since)}` +
        `&time=lte.${encodeURIComponent(until)}` +
        `&select=*&order=time.desc&limit=5000`
    );
    activity = Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.error("ACTIVITY FETCH ERROR:", error);
    warnings.push("user_activity could not be loaded.");
  }

  // ---------- errors ----------
  let errors = [];
  try {
    const rows = await supabaseRequest(
      env,
      `errors?api_key=eq.${apiKey}` +
        `&timestamp=gte.${encodeURIComponent(since)}` +
        `&timestamp=lte.${encodeURIComponent(until)}` +
        `&select=*&order=timestamp.desc&limit=2000`
    );
    errors = Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.error("ERRORS FETCH ERROR:", error);
    warnings.push("errors could not be loaded.");
  }

  return {
    application: { id: application.id, name: application.name || null },
    period: { from: since, to: until, days: 7 },
    user_activity: activity,
    errors,
    data_warnings: warnings,
  };
}


// ============================================================
// ANALYTICS SUMMARY
// ============================================================

function getEventName(event) {
  if (typeof event === "string") return event;
  if (event && typeof event === "object") {
    return String(event.name || event.event || event.type || "unknown");
  }
  return "unknown";
}

function buildAnalyticsSummary(analytics) {
  const activity = analytics.user_activity || [];
  const errors = analytics.errors || [];

  const sessions = new Set();
  const eventCounts = {};
  const errorCounts = {};
  const daily = {};

  for (const row of activity) {
    // Sessions (NOT customers). Null session IDs are skipped.
    if (row.session_id) sessions.add(String(row.session_id));

    // Event counts
    const name = getEventName(row.event);
    eventCounts[name] = (eventCounts[name] || 0) + 1;

    // Daily sessions
    if (row.time) {
      const d = new Date(row.time);
      if (!isNaN(d.getTime())) {
        const date = d.toISOString().slice(0, 10);
        if (!daily[date]) daily[date] = new Set();
        if (row.session_id) daily[date].add(String(row.session_id));
      }
    }
  }

  for (const error of errors) {
    const message = String(error.error_message || "Unknown error");
    errorCounts[message] = (errorCounts[message] || 0) + 1;
  }

  const top = (counts, key) =>
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([label, count]) => ({ [key]: truncate(label, 200), count }));

  const dailySessions = Object.entries(daily)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, set]) => ({ date, sessions: set.size }));

  return {
    total_activity_rows: activity.length,
    total_sessions_with_session_id: sessions.size,
    total_errors: errors.length,
    top_events: top(eventCounts, "event"),
    top_errors: top(errorCounts, "error"),
    daily_sessions: dailySessions,

    // Small trimmed samples only. The full dataset is already
    // summarized above, so we never send thousands of rows.
    recent_activity: activity.slice(0, 30).map((r) => ({
      session_id: r.session_id ?? null,
      time: r.time ?? null,
      event: truncate(getEventName(r.event), 100),
    })),

    recent_errors: errors.slice(0, 20).map((e) => ({
      time: e.timestamp ?? null,
      error_message: truncate(e.error_message || "Unknown error", 200),
      ai_analysis: truncate(e.ai_analysis || "", 200),
    })),
  };
}


// ============================================================
// ANALYST
// ============================================================

async function analyzeQuestion(env, question, analytics) {
  const summary = buildAnalyticsSummary(analytics);

  const prompt = JSON.stringify({
    founder_question: question,
    application: analytics.application,
    analytics_period: analytics.period,
    data_warnings: analytics.data_warnings,
    summary,
  });

  return callSarvam(env, ANALYST_SYSTEM_PROMPT, prompt, 2000);
}


// ============================================================
// REQUEST VALIDATION
// ============================================================

function validateRequest(body) {
  if (!body || typeof body !== "object") return "Invalid request body.";
  if (!body.id) return "Missing id.";
  if (!body.user_id) return "Missing user_id.";
  if (!body.application_id) return "Missing application_id.";
  if (!body.question) return "Missing question.";
  if (typeof body.question !== "string") return "Question must be a string.";
  if (body.question.trim().length === 0) return "Question cannot be empty.";
  return null;
}


// ============================================================
// MAIN HANDLER
// ============================================================

async function handleRequest(request, env) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON." }, 400);
  }

  const validationError = validateRequest(body);
  if (validationError) {
    return json({ error: validationError }, 400);
  }

  const messageId = String(body.id);
  const userId = String(body.user_id);
  const applicationId = String(body.application_id);
  const question = String(body.question).trim();

  try {
    // 1. Verify application
    const application = await verifyApplication(env, applicationId, userId);

    if (!application) {
      const reply = "I couldn't verify this SaaS application.";
      await saveReply(env, messageId, reply);
      return json({ success: false, reply, classification: "ERROR" }, 403);
    }

    // 2. Classifier (every question)
    const classification = await classifyQuestion(env, question);

    // 3. NO_WORK -> 1 AI call
    if (classification.classification === "NO_WORK") {
      const reply = classification.reply;
      await saveReply(env, messageId, reply);
      return json({
        success: true,
        reply,
        classification: "NO_WORK",
        ai_calls: 1,
      });
    }

    // 4. NEED_WORK -> fetch data, then analyst (2 AI calls)
    const analytics = await getAnalyticsData(env, application);
    const reply = await analyzeQuestion(env, question, analytics);

    await saveReply(env, messageId, reply);

    return json({
      success: true,
      reply,
      classification: "NEED_WORK",
      ai_calls: 2,
    });
  } catch (error) {
    console.error("WORKER ERROR:", error);

    const errorReply =
      "Sorry, I couldn't process your request right now. Please try again.";

    await saveReply(env, messageId, errorReply);

    return json(
      {
        success: false,
        reply: errorReply,
        ...(DEBUG ? { debug: String(error?.message || error) } : {}),
      },
      500
    );
  }
}


// ============================================================
// ENTRY POINT
// ============================================================

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    return handleRequest(request, env);
  },
};
