// ============================================================
// REPORTLI AI — AI CO-FOUNDER CHAT WORKER (v2, multi-source)
// ============================================================
//
// FLOW:
//   User -> Worker -> verify app -> load chat history
//     -> CLASSIFIER AI (NO_WORK or NEED_WORK + which sources)
//     NO_WORK   -> save classifier reply
//     NEED_WORK -> fetch ONLY the needed tables -> summarize
//               -> ANALYST AI -> save reply
//
// REQUEST:
//   { id, user_id, application_id, question }
//
// REQUIRED WORKER SECRETS:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   SARVAM_API_KEY
//
// SECURITY:
//   - Every query selects explicit columns. Secrets such as
//     applications.api_key and gmail connected_account_id are
//     NEVER sent to the AI.
//   - Lead email addresses and email bodies are NOT sent unless
//     you enable the flags below.
// ============================================================

const SARVAM_URL = "https://api.sarvam.ai/v1/chat/completions";
const SARVAM_MODEL = "sarvam-105b";

const DEBUG = true; // set false once stable

// Privacy flags
const INCLUDE_LEAD_EMAILS = false;
const INCLUDE_EMAIL_SNIPPETS = false;

// Limits
const ACTIVITY_DAYS = 7;
const RECENT_DAYS = 30;
const MAX_ROWS = 2000;

const VALID_SOURCES = [
  "activity",
  "errors",
  "leads",
  "emails",
  "reddit",
  "niches",
  "planner",
];


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
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function daysAgoISO(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function countBy(rows, fn) {
  const counts = {};
  for (const row of rows) {
    const key = String(fn(row) ?? "unknown") || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function topList(counts, keyName, n = 10) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([label, count]) => ({ [keyName]: truncate(label, 120), count }));
}

function dailyCounts(rows, field, days) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const counts = {};
  for (const row of rows) {
    const t = row[field] ? new Date(row[field]).getTime() : NaN;
    if (isNaN(t) || t < since) continue;
    const date = new Date(t).toISOString().slice(0, 10);
    counts[date] = (counts[date] || 0) + 1;
  }
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));
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

// A failed table never kills the whole request. It becomes a warning.
async function safeFetch(env, label, path, warnings) {
  try {
    const rows = await supabaseRequest(env, path);
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.error(`FETCH ERROR (${label}):`, error);
    warnings.push(`${label} data could not be loaded.`);
    return [];
  }
}

// chat_messages uses `id` (text)
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

// application_id + user_id must match. api_key stays server-side only.
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
// CHAT HISTORY (so follow-up questions work)
// ============================================================

async function getChatHistory(env, messageId, applicationId) {
  try {
    const current = await supabaseRequest(
      env,
      `chat_messages?id=eq.${encodeURIComponent(messageId)}&select=conversation_id&limit=1`
    );

    const conversationId = current?.[0]?.conversation_id;
    if (!conversationId) return [];

    const rows = await supabaseRequest(
      env,
      `chat_messages?conversation_id=eq.${encodeURIComponent(conversationId)}` +
        `&application_id=eq.${encodeURIComponent(applicationId)}` +
        `&id=neq.${encodeURIComponent(messageId)}` +
        `&reply=not.is.null&select=question,reply,created_at` +
        `&order=created_at.desc&limit=6`
    );

    return (Array.isArray(rows) ? rows : [])
      .reverse()
      .filter((r) => r.question && r.reply)
      .map((r) => ({
        founder: truncate(r.question, 300),
        assistant: truncate(r.reply, 400),
      }));
  } catch (error) {
    console.error("HISTORY ERROR:", error);
    return [];
  }
}


// ============================================================
// PROMPTS
// ============================================================

const CLASSIFIER_SYSTEM_PROMPT = `
You are Reportli AI's classifier.

Decide if the founder's question needs data from their SaaS workspace.

NO_WORK = greetings, casual talk, thanks, or general help that needs no data.
NEED_WORK = anything about their numbers, activity, leads, emails, Reddit research, niches, errors, or automation runs.

Available data sources:
- activity: product sessions and events (last 7 days)
- errors: application errors (last 7 days)
- leads: outbound leads, job titles, companies, email status, reply status
- emails: Gmail inbox processing, categories, AI draft replies, failures
- reddit: Reddit research posts found for customer niches
- niches: customer niches, buying intention, Reddit/Apollo status
- planner: automation/planner runs, their status and failures

For NEED_WORK, list ONLY the sources needed. Use the recent conversation to resolve follow-up questions like "what about last week?".
For broad questions ("how is my business doing?") include all sources.

For NO_WORK, write a short natural reply. For NEED_WORK, reply is null.
Never invent data, customers, revenue, or percentages.

Return ONLY valid JSON, no markdown, no explanation:

{"classification":"NO_WORK","reply":"...","sources":[]}
{"classification":"NEED_WORK","reply":null,"sources":["leads","emails"]}
`;

const ANALYST_SYSTEM_PROMPT = `
You are Reportli AI, an AI co-founder for SaaS founders.

Answer the founder's question using ONLY the supplied data.

Rules:
- Never invent numbers, customers, revenue, percentages, or data.
- Sessions are NOT unique customers.
- Only sources listed in sources_loaded were fetched. For anything else, say you didn't check it.
- product activity and errors cover the last 7 days. Other sources cover the most recent rows; if a section says truncated=true, say the figures are for the latest rows only.
- If data is empty, insufficient, or in data_warnings, say so plainly.
- Use recent_conversation to understand follow-up questions.
- Give concise, founder-level insights: what the numbers mean and why it matters.
- Give one practical next step when useful.
- Never mention Sarvam, Cloudflare, SQL, Supabase, the Worker, or table names.
- Keep answers short and natural. Do not output your reasoning, only the final answer.
`;


// ============================================================
// SARVAM
// ============================================================

function stripThinking(text) {
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
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
// Never throws on bad model output. Unclear -> NEED_WORK with all
// sources, so the founder still gets a real answer.
// ============================================================

async function classifyQuestion(env, question, history) {
  const raw = await callSarvam(
    env,
    CLASSIFIER_SYSTEM_PROMPT,
    JSON.stringify({ recent_conversation: history, question }),
    1500
  );

  const fallback = { classification: "NEED_WORK", reply: null, sources: VALID_SOURCES };

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error("CLASSIFIER NON-JSON:", truncate(raw, 300));
    return fallback;
  }

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    console.error("CLASSIFIER BAD JSON:", truncate(raw, 300));
    return fallback;
  }

  const classification = String(parsed?.classification || "").trim().toUpperCase();

  if (classification === "NO_WORK") {
    if (typeof parsed.reply === "string" && parsed.reply.trim()) {
      return { classification: "NO_WORK", reply: parsed.reply.trim(), sources: [] };
    }
    return fallback;
  }

  let sources = Array.isArray(parsed.sources)
    ? parsed.sources
        .map((s) => String(s).trim().toLowerCase())
        .filter((s) => VALID_SOURCES.includes(s))
    : [];

  if (sources.length === 0) sources = VALID_SOURCES;

  return { classification: "NEED_WORK", reply: null, sources: [...new Set(sources)] };
}


// ============================================================
// DATA LOADERS (explicit columns, no secrets)
// ============================================================

async function loadData(env, application, sources) {
  const warnings = [];
  const appId = encodeURIComponent(application.id);
  const apiKey = application.api_key ? encodeURIComponent(application.api_key) : null;

  const since7 = encodeURIComponent(daysAgoISO(ACTIVITY_DAYS));
  const since30 = encodeURIComponent(daysAgoISO(RECENT_DAYS));
  const until = encodeURIComponent(new Date().toISOString());

  const jobs = {};

  // ---------- Product analytics (keyed by api_key) ----------
  if (sources.includes("activity")) {
    jobs.activity = apiKey
      ? safeFetch(
          env,
          "Product activity",
          `user_activity?api_key=eq.${apiKey}&time=gte.${since7}&time=lte.${until}` +
            `&select=id,user_id,session_id,time,event&order=time.desc&limit=5000`,
          warnings
        )
      : Promise.resolve([]);
  }

  if (sources.includes("errors")) {
    jobs.errors = apiKey
      ? safeFetch(
          env,
          "Errors",
          `errors?api_key=eq.${apiKey}&timestamp=gte.${since7}&timestamp=lte.${until}` +
            `&select=id,error_message,timestamp,user_id,ai_analysis&order=timestamp.desc&limit=${MAX_ROWS}`,
          warnings
        )
      : Promise.resolve([]);
  }

  // ---------- Growth data (keyed by application_id) ----------
  if (sources.includes("leads")) {
    jobs.leads = safeFetch(
      env,
      "Leads",
      `leads?application_id=eq.${appId}` +
        `&select=id,task_id,full_name,job_title,company_name,company_domain,email_status,reply_status,message,created_at` +
        (INCLUDE_LEAD_EMAILS ? ",email" : "") +
        `&order=created_at.desc&limit=${MAX_ROWS}`,
      warnings
    );
  }

  if (sources.includes("emails")) {
    jobs.emails = safeFetch(
      env,
      "Email processing",
      `gmail_processed_messages?application_id=eq.${appId}&created_at=gte.${since30}` +
        `&select=id,sender_name,email_category,should_reply,gmail_draft_id,status,error_message,email_received_at,processed_at,created_at` +
        (INCLUDE_EMAIL_SNIPPETS ? ",email_content" : "") +
        `&order=created_at.desc&limit=${MAX_ROWS}`,
      warnings
    );
  }

  if (sources.includes("reddit")) {
    jobs.reddit = safeFetch(
      env,
      "Reddit research",
      `reddit_research_results?application_id=eq.${appId}&created_at=gte.${since30}` +
        `&select=id,subreddit,title,post_url,created_utc,score,num_comments,customer_niche,matched_query,relevance_score,created_at` +
        `&order=created_at.desc&limit=${MAX_ROWS}`,
      warnings
    );
  }

  if (sources.includes("niches")) {
    jobs.niches = safeFetch(
      env,
      "Customer niches",
      `customer_niches?application_id=eq.${appId}` +
        `&select=niche_name,buying_intention,reddit_status,apollo_status,created_at` +
        `&order=buying_intention.desc.nullslast&limit=200`,
      warnings
    );
  }

  if (sources.includes("planner")) {
    jobs.planner = safeFetch(
      env,
      "Planner runs",
      `planner_runs?application_id=eq.${appId}` +
        `&select=worker_type,source,task,status,pending_count,error,niche,created_at,started_at` +
        `&order=created_at.desc&limit=100`,
      warnings
    );
  }

  // Company profile is small and gives the AI business context.
  jobs.company = safeFetch(
    env,
    "Company profile",
    `company_data?application_id=eq.${appId}&select=field,data,updated_at&limit=100`,
    warnings
  );

  // Run everything in parallel.
  const keys = Object.keys(jobs);
  const results = await Promise.all(keys.map((k) => jobs[k]));

  const data = { warnings };
  keys.forEach((k, i) => (data[k] = results[i]));
  return data;
}


// ============================================================
// SUMMARIES (compact, so the prompt stays small)
// ============================================================

function getEventName(event) {
  if (typeof event === "string") return event;
  if (event && typeof event === "object") {
    return String(event.name || event.event || event.type || "unknown");
  }
  return "unknown";
}

function summarizeActivity(activity) {
  const sessions = new Set();
  const daily = {};

  for (const row of activity) {
    if (row.session_id) sessions.add(String(row.session_id));

    if (row.time) {
      const d = new Date(row.time);
      if (!isNaN(d.getTime())) {
        const date = d.toISOString().slice(0, 10);
        if (!daily[date]) daily[date] = new Set();
        if (row.session_id) daily[date].add(String(row.session_id));
      }
    }
  }

  return {
    period: `last ${ACTIVITY_DAYS} days`,
    truncated: activity.length >= 5000,
    total_activity_rows: activity.length,
    total_sessions_with_session_id: sessions.size,
    top_events: topList(countBy(activity, (r) => getEventName(r.event)), "event", 20),
    daily_sessions: Object.entries(daily)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, set]) => ({ date, sessions: set.size })),
  };
}

function summarizeErrors(errors) {
  return {
    period: `last ${ACTIVITY_DAYS} days`,
    truncated: errors.length >= MAX_ROWS,
    total_errors: errors.length,
    top_errors: topList(countBy(errors, (e) => e.error_message || "Unknown error"), "error", 15),
    recent_errors: errors.slice(0, 10).map((e) => ({
      time: e.timestamp,
      error_message: truncate(e.error_message, 200),
      ai_analysis: truncate(e.ai_analysis, 200),
    })),
  };
}

function summarizeLeads(leads) {
  return {
    scope: "all time, latest rows",
    truncated: leads.length >= MAX_ROWS,
    total_leads: leads.length,
    by_email_status: countBy(leads, (l) => l.email_status || "unknown"),
    by_reply_status: countBy(leads, (l) => l.reply_status || "no_status"),
    leads_with_reply_message: leads.filter((l) => l.message).length,
    top_companies: topList(countBy(leads, (l) => l.company_name || "unknown"), "company", 10),
    top_job_titles: topList(countBy(leads, (l) => l.job_title || "unknown"), "job_title", 10),
    leads_added_per_day_last_14d: dailyCounts(leads, "created_at", 14),
    recent_leads: leads.slice(0, 10).map((l) => ({
      name: l.full_name || null,
      job_title: l.job_title || null,
      company: l.company_name || null,
      email_status: l.email_status || null,
      reply_status: l.reply_status || null,
      added: l.created_at,
      ...(INCLUDE_LEAD_EMAILS ? { email: l.email } : {}),
    })),
    recent_replies: leads
      .filter((l) => l.message)
      .slice(0, 5)
      .map((l) => ({
        from: l.full_name || l.company_name || "unknown",
        reply_status: l.reply_status || null,
        message: truncate(l.message, 250),
      })),
  };
}

function summarizeEmails(emails) {
  const failed = emails.filter((e) => e.error_message);

  return {
    period: `last ${RECENT_DAYS} days`,
    truncated: emails.length >= MAX_ROWS,
    total_emails_processed: emails.length,
    by_status: countBy(emails, (e) => e.status || "unknown"),
    by_category: countBy(emails, (e) => e.email_category || "uncategorized"),
    should_reply_count: emails.filter((e) => e.should_reply === true).length,
    ai_drafts_created: emails.filter((e) => e.gmail_draft_id).length,
    failed_count: failed.length,
    top_failure_reasons: topList(countBy(failed, (e) => e.error_message), "error", 5),
    emails_per_day_last_14d: dailyCounts(emails, "created_at", 14),
    recent_emails: emails.slice(0, 10).map((e) => ({
      sender: e.sender_name || null,
      category: e.email_category || null,
      should_reply: e.should_reply,
      status: e.status,
      draft_created: Boolean(e.gmail_draft_id),
      received: e.email_received_at || null,
      ...(INCLUDE_EMAIL_SNIPPETS ? { snippet: truncate(e.email_content, 120) } : {}),
    })),
  };
}

function summarizeReddit(posts) {
  const scored = posts.filter((p) => typeof p.relevance_score === "number");
  const avg = scored.length
    ? Math.round((scored.reduce((s, p) => s + p.relevance_score, 0) / scored.length) * 10) / 10
    : null;

  return {
    period: `last ${RECENT_DAYS} days`,
    truncated: posts.length >= MAX_ROWS,
    total_posts_found: posts.length,
    average_relevance_score: avg,
    by_subreddit: topList(countBy(posts, (p) => p.subreddit || "unknown"), "subreddit", 10),
    by_niche: topList(countBy(posts, (p) => p.customer_niche || "unknown"), "niche", 10),
    top_queries: topList(countBy(posts, (p) => p.matched_query || "unknown"), "query", 10),
    top_posts_by_relevance: [...scored]
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, 8)
      .map((p) => ({
        title: truncate(p.title, 150),
        subreddit: p.subreddit,
        relevance_score: p.relevance_score,
        reddit_score: p.score ?? null,
        comments: p.num_comments ?? null,
        niche: p.customer_niche || null,
        url: p.post_url,
        posted: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : null,
      })),
  };
}

function summarizeNiches(niches) {
  return {
    total_niches: niches.length,
    niches: niches.map((n) => ({
      niche: truncate(n.niche_name, 100),
      buying_intention: n.buying_intention ?? null,
      reddit_status: n.reddit_status,
      apollo_status: n.apollo_status,
    })),
  };
}

function summarizePlanner(runs) {
  return {
    scope: "latest 100 runs",
    total_runs: runs.length,
    by_status: countBy(runs, (r) => r.status || "unknown"),
    by_worker_type: countBy(runs, (r) => r.worker_type || "unknown"),
    runs_with_errors: runs.filter((r) => r.error).length,
    recent_runs: runs.slice(0, 10).map((r) => ({
      worker_type: r.worker_type,
      source: r.source,
      task: truncate(r.task, 150),
      status: r.status || null,
      pending_count: r.pending_count,
      niche: r.niche || null,
      error: r.error ? truncate(r.error, 200) : null,
      created: r.created_at,
    })),
  };
}

// Company profile: skip anything that looks like a credential.
function summarizeCompany(rows) {
  const SECRET_FIELD = /key|secret|token|password|credential|private/i;

  return rows
    .filter((r) => r.field && !SECRET_FIELD.test(r.field))
    .map((r) => ({ field: r.field, data: truncate(r.data, 500) }));
}

function buildSummary(data, sources) {
  const summary = {};

  if (sources.includes("activity")) summary.product_activity = summarizeActivity(data.activity || []);
  if (sources.includes("errors")) summary.errors = summarizeErrors(data.errors || []);
  if (sources.includes("leads")) summary.leads = summarizeLeads(data.leads || []);
  if (sources.includes("emails")) summary.emails = summarizeEmails(data.emails || []);
  if (sources.includes("reddit")) summary.reddit_research = summarizeReddit(data.reddit || []);
  if (sources.includes("niches")) summary.customer_niches = summarizeNiches(data.niches || []);
  if (sources.includes("planner")) summary.automation_runs = summarizePlanner(data.planner || []);

  summary.company_profile = summarizeCompany(data.company || []);

  return summary;
}


// ============================================================
// ANALYST
// ============================================================

async function analyzeQuestion(env, question, application, history, sources, data) {
  const prompt = JSON.stringify({
    founder_question: question,
    recent_conversation: history,
    application: { name: application.name || null },
    sources_loaded: sources,
    data_warnings: data.warnings,
    summary: buildSummary(data, sources),
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
    // 1. Verify application ownership
    const application = await verifyApplication(env, applicationId, userId);

    if (!application) {
      const reply = "I couldn't verify this SaaS application.";
      await saveReply(env, messageId, reply);
      return json({ success: false, reply, classification: "ERROR" }, 403);
    }

    // 2. Conversation memory
    const history = await getChatHistory(env, messageId, applicationId);

    // 3. Classifier (decides NO_WORK / NEED_WORK + sources)
    const classification = await classifyQuestion(env, question, history);

    // 4. NO_WORK -> 1 AI call
    if (classification.classification === "NO_WORK") {
      await saveReply(env, messageId, classification.reply);
      return json({
        success: true,
        reply: classification.reply,
        classification: "NO_WORK",
        ai_calls: 1,
      });
    }

    // 5. NEED_WORK -> fetch only the needed tables
    const sources = classification.sources;
    const data = await loadData(env, application, sources);

    // 6. Analyst -> 2 AI calls total
    const reply = await analyzeQuestion(env, question, application, history, sources, data);

    await saveReply(env, messageId, reply);

    return json({
      success: true,
      reply,
      classification: "NEED_WORK",
      sources,
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
