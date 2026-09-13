// ============================================================
// REPORTLI AI — CHAT WORKER
// Cloudflare Worker
// ============================================================

const SARVAM_URL = "https://api.sarvam.ai/v1/chat/completions";
const SARVAM_MODEL = "sarvam-105b";

// Only allow these tables and columns.
// Sarvam can SELECT from this schema,
// but it can NEVER generate SQL.
const ALLOWED_SCHEMA = {
  chat_messages: [
    "id",
    "user_id",
    "application_id",
    "conversation_id",
    "role",
    "question",
    "reply",
    "created_at",
  ],

  user_activity: [
    "id",
    "user_id",
    "session_id",
    "time",
    "event",
    "api_key",
  ],

  errors: [
    "id",
    "api_key",
    "error_message",
    "timestamp",
    "ai_analysis",
    "user_id",
  ],
};

// Maximum rows we will fetch from one table.
const MAX_ROWS_PER_TABLE = 5000;

// Only analyze the last 7 days.
const DAYS_TO_ANALYZE = 7;


// ============================================================
// CORS
// ============================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}


// ============================================================
// JSON RESPONSE
// ============================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json",
    },
  });
}


// ============================================================
// GET LAST 7 DAYS TIME RANGE
// ============================================================

function getSevenDaysAgo() {
  return new Date(
    Date.now() - DAYS_TO_ANALYZE * 24 * 60 * 60 * 1000
  ).toISOString();
}


// ============================================================
// SUPABASE REQUEST
// ============================================================

async function supabaseRequest(env, path, options = {}) {
  const url = `${env.SUPABASE_URL}/rest/v1/${path}`;

  const response = await fetch(url, {
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
    console.error("SUPABASE ERROR", {
      status: response.status,
      statusText: response.statusText,
      body: data,
      path,
    });

    throw new Error(
      `Supabase error ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}


// ============================================================
// SARVAM REQUEST
// ============================================================

async function sarvamRequest(env, body, label = "SARVAM") {
  const response = await fetch(SARVAM_URL, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",

      // Sarvam API authentication
      "api-subscription-key": env.SARVAM_API_KEY,

      // Bearer authentication is also supported
      Authorization: `Bearer ${env.SARVAM_API_KEY}`,
    },

    body: JSON.stringify(body),
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    console.error(`${label} ERROR`, {
      status: response.status,
      statusText: response.statusText,
      body: data,
    });

    throw new Error(
      `${label} failed (${response.status}): ${JSON.stringify(data)}`
    );
  }

  return data;
}


// ============================================================
// EXTRACT SARVAM MESSAGE
// ============================================================

function extractSarvamContent(data) {
  const content = data?.choices?.[0]?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error(
      `Sarvam returned no message content: ${JSON.stringify(data)}`
    );
  }

  return content.trim();
}


// ============================================================
// PARSE JSON SAFELY
// ============================================================

function parseJsonFromSarvam(content) {
  try {
    return JSON.parse(content);
  } catch {
    // Sometimes models return JSON inside markdown fences.
    const cleaned = content
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      throw new Error(
        `Sarvam returned invalid JSON: ${content}`
      );
    }
  }
}


// ============================================================
// CREATE DATA PLAN
//
// Sarvam 105B #1
//
// Its job:
// - Understand the question
// - Decide which table(s) are needed
// - Decide which columns are needed
//
// It does NOT generate SQL.
// ============================================================

async function createDataPlan(env, question) {
  const schemaDescription = Object.entries(ALLOWED_SCHEMA)
    .map(([table, columns]) => {
      return `${table}: ${columns.join(", ")}`;
    })
    .join("\n");

  const systemPrompt = `
You are the DATA PLANNER for Reportli AI.

Your ONLY job is to understand the user's question and decide
which Reportli database tables and columns are required to answer it.

DATABASE SCHEMA:

${schemaDescription}

IMPORTANT RULES:

1. Only use tables and columns listed above.
2. Never invent a table.
3. Never invent a column.
4. Never generate SQL.
5. Never request customer information that does not exist.
6. user_activity contains sessions and events, not customer profiles.
7. errors contains error information.
8. users is NOT available to this planner.
9. applications is NOT available to this planner.
10. Only data from the last 7 days is available for analytics.
11. chat_messages should only be selected when the user is asking about
    previous Reportli conversations/chat history.
12. Select only the columns genuinely needed.
13. If the question cannot be answered using this schema, return
    can_answer=false.
14. Keep the plan small and precise.

AVAILABLE DATA:

user_activity:
- id
- user_id
- session_id
- time
- event
- api_key

errors:
- id
- api_key
- error_message
- timestamp
- ai_analysis
- user_id

chat_messages:
- id
- user_id
- application_id
- conversation_id
- role
- question
- reply
- created_at

The application context is supplied separately by the Worker.

Return ONLY the requested JSON structure.
`;

  const userPrompt = `
USER QUESTION:

${question}
`;

  const body = {
    model: SARVAM_MODEL,

    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: userPrompt,
      },
    ],

    // IMPORTANT:
    // Planner does not need reasoning.
    // This prevents reasoning tokens from consuming
    // the small planner output budget.
    reasoning_effort: null,

    temperature: 0,

    max_tokens: 1000,

    response_format: {
      type: "json_schema",

      json_schema: {
        name: "reportli_data_plan",

        strict: true,

        schema: {
          type: "object",

          additionalProperties: false,

          properties: {
            can_answer: {
              type: "boolean",
            },

            reason: {
              type: "string",
            },

            tables: {
              type: "array",

              items: {
                type: "object",

                additionalProperties: false,

                properties: {
                  table: {
                    type: "string",

                    enum: [
                      "user_activity",
                      "errors",
                      "chat_messages",
                    ],
                  },

                  columns: {
                    type: "array",

                    items: {
                      type: "string",
                    },
                  },
                },

                required: [
                  "table",
                  "columns",
                ],
              },
            },
          },

          required: [
            "can_answer",
            "reason",
            "tables",
          ],
        },
      },
    },
  };

  const data = await sarvamRequest(
    env,
    body,
    "SARVAM PLANNER"
  );

  const content = extractSarvamContent(data);

  const plan = parseJsonFromSarvam(content);

  return plan;
}


// ============================================================
// VALIDATE DATA PLAN
//
// NEVER trust Sarvam blindly.
//
// Worker checks every table and every column.
// ============================================================

function validatePlan(plan) {
  if (!plan || typeof plan !== "object") {
    throw new Error("Invalid planner response");
  }

  if (typeof plan.can_answer !== "boolean") {
    throw new Error("Planner missing can_answer");
  }

  if (typeof plan.reason !== "string") {
    throw new Error("Planner missing reason");
  }

  if (!Array.isArray(plan.tables)) {
    throw new Error("Planner missing tables");
  }

  // If Sarvam says it cannot answer,
  // there is no database query.
  if (!plan.can_answer) {
    return {
      can_answer: false,
      reason: plan.reason,
      tables: [],
    };
  }

  const validatedTables = [];

  for (const requestedTable of plan.tables) {
    if (!requestedTable || typeof requestedTable !== "object") {
      throw new Error("Invalid table plan");
    }

    const table = requestedTable.table;

    if (!Object.prototype.hasOwnProperty.call(
      ALLOWED_SCHEMA,
      table
    )) {
      throw new Error(
        `Planner requested forbidden table: ${table}`
      );
    }

    if (!Array.isArray(requestedTable.columns)) {
      throw new Error(
        `Planner columns missing for table: ${table}`
      );
    }

    const allowedColumns = ALLOWED_SCHEMA[table];

    const columns = [];

    for (const column of requestedTable.columns) {
      if (
        typeof column !== "string" ||
        !allowedColumns.includes(column)
      ) {
        throw new Error(
          `Planner requested forbidden column: ${table}.${column}`
        );
      }

      if (!columns.includes(column)) {
        columns.push(column);
      }
    }

    if (columns.length === 0) {
      throw new Error(
        `Planner requested no columns for table: ${table}`
      );
    }

    validatedTables.push({
      table,
      columns,
    });
  }

  return {
    can_answer: true,
    reason: plan.reason,
    tables: validatedTables,
  };
}


// ============================================================
// SUPABASE QUERY HELPERS
// ============================================================


// ------------------------------------------------------------
// USER ACTIVITY
// ------------------------------------------------------------

async function fetchUserActivity(
  env,
  apiKey,
  columns
) {
  const select = columns.join(",");

  const sevenDaysAgo = getSevenDaysAgo();

  const path =
    `user_activity?select=${encodeURIComponent(select)}` +
    `&api_key=eq.${encodeURIComponent(apiKey)}` +
    `&time=gte.${encodeURIComponent(sevenDaysAgo)}` +
    `&order=time.desc` +
    `&limit=${MAX_ROWS_PER_TABLE}`;

  return await supabaseRequest(env, path);
}


// ------------------------------------------------------------
// ERRORS
// ------------------------------------------------------------

async function fetchErrors(
  env,
  apiKey,
  columns
) {
  const select = columns.join(",");

  const sevenDaysAgo = getSevenDaysAgo();

  const path =
    `errors?select=${encodeURIComponent(select)}` +
    `&api_key=eq.${encodeURIComponent(apiKey)}` +
    `&timestamp=gte.${encodeURIComponent(sevenDaysAgo)}` +
    `&order=timestamp.desc` +
    `&limit=${MAX_ROWS_PER_TABLE}`;

  return await supabaseRequest(env, path);
}


// ------------------------------------------------------------
// CHAT MESSAGES
// ------------------------------------------------------------

async function fetchChatMessages(
  env,
  userId,
  applicationId,
  columns
) {
  const select = columns.join(",");

  const sevenDaysAgo = getSevenDaysAgo();

  const path =
    `chat_messages?select=${encodeURIComponent(select)}` +
    `&user_id=eq.${encodeURIComponent(userId)}` +
    `&application_id=eq.${encodeURIComponent(applicationId)}` +
    `&created_at=gte.${encodeURIComponent(sevenDaysAgo)}` +
    `&order=created_at.desc` +
    `&limit=${MAX_ROWS_PER_TABLE}`;

  return await supabaseRequest(env, path);
}


// ============================================================
// EXECUTE DATA PLAN
// ============================================================

async function executeDataPlan(
  env,
  plan,
  context
) {
  const results = {};

  for (const tablePlan of plan.tables) {
    const {
      table,
      columns,
    } = tablePlan;

    if (table === "user_activity") {
      results.user_activity =
        await fetchUserActivity(
          env,
          context.apiKey,
          columns
        );
    }

    else if (table === "errors") {
      results.errors =
        await fetchErrors(
          env,
          context.apiKey,
          columns
        );
    }

    else if (table === "chat_messages") {
      results.chat_messages =
        await fetchChatMessages(
          env,
          context.userId,
          context.applicationId,
          columns
        );
    }
  }

  return results;
}


// ============================================================
// FINAL SARVAM ANALYSIS
//
// Sarvam 105B #2
//
// This call receives:
// - Original question
// - Database data
// - Context
//
// It analyzes the data and writes the final answer.
// ============================================================

async function generateFinalAnswer(
  env,
  question,
  data,
  context
) {
  const systemPrompt = `
You are Reportli AI.

You are an AI co-founder for a SaaS founder.

Your job is to analyze the supplied SaaS data and answer
the founder's question clearly and honestly.

IMPORTANT DATA LIMITS:

1. You only have data supplied in this request.
2. The analytics data covers only the last 7 days.
3. user_activity represents sessions and events.
4. It does NOT represent a complete customer database.
5. Do not claim to know a customer's identity unless the data
   explicitly contains enough information.
6. Do not invent missing data.
7. Do not invent revenue, conversion, churn, retention,
   customer names, or customer profiles.
8. If something cannot be determined, say so.
9. Use exact numbers from the supplied data.
10. Do not mention internal database implementation unless useful.
11. Give practical founder-focused conclusions.
12. If there is a problem, explain:
    - what happened
    - how often it happened
    - why it matters
    - what the founder should investigate or do next
13. Do not pretend that sessions are unique users.
14. If the question asks for "users" but the data only contains
    sessions, clearly explain the limitation.
15. Keep the response concise but useful.
`;

  const userPrompt = `
APPLICATION CONTEXT:

Application ID:
${context.applicationId}

API key:
${context.apiKey}

USER QUESTION:

${question}

DATABASE DATA:

${JSON.stringify(data)}
`;

  const body = {
    model: SARVAM_MODEL,

    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: userPrompt,
      },
    ],

    // Final answer can use reasoning.
    reasoning_effort: "medium",

    temperature: 0.2,

    max_tokens: 2500,
  };

  const response = await sarvamRequest(
    env,
    body,
    "SARVAM ANALYST"
  );

  return extractSarvamContent(response);
}


// ============================================================
// FIND EXISTING CHAT MESSAGE
//
// Current frontend architecture creates the question row first.
// Worker finds that row and adds the reply.
//
// NOTE:
// A future improvement is sending message_id directly.
// ============================================================

async function findPendingChatMessage(
  env,
  context,
  question
) {
  const path =
    `chat_messages?select=id` +
    `&user_id=eq.${encodeURIComponent(context.userId)}` +
    `&application_id=eq.${encodeURIComponent(context.applicationId)}` +
    `&conversation_id=eq.${encodeURIComponent(context.conversationId)}` +
    `&question=eq.${encodeURIComponent(question)}` +
    `&reply=is.null` +
    `&order=created_at.desc` +
    `&limit=1`;

  const rows = await supabaseRequest(
    env,
    path
  );

  return rows?.[0]?.id || null;
}


// ============================================================
// SAVE REPLY
// ============================================================

async function saveReply(
  env,
  messageId,
  reply
) {
  if (!messageId) {
    console.warn(
      "No pending chat message found. Reply will not be saved."
    );

    return;
  }

  const path =
    `chat_messages?id=eq.${encodeURIComponent(messageId)}`;

  await supabaseRequest(
    env,
    path,
    {
      method: "PATCH",

      headers: {
        Prefer: "return=minimal",
      },

      body: JSON.stringify({
        reply,
      }),
    }
  );
}


// ============================================================
// MAIN CHAT HANDLER
// ============================================================

async function handleChat(request, env) {
  let body;

  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      {
        error: "Invalid JSON body",
      },
      400
    );
  }

  const {
    user_id,
    application_id,
    conversation_id,
    question,
    api_key,
  } = body;

  // ----------------------------------------------------------
  // VALIDATE REQUEST
  // ----------------------------------------------------------

  if (
    !user_id ||
    !application_id ||
    !conversation_id ||
    !question
  ) {
    return jsonResponse(
      {
        error:
          "user_id, application_id, conversation_id and question are required",
      },
      400
    );
  }

  // ----------------------------------------------------------
  // API KEY
  //
  // The frontend should ideally provide the application's API key.
  // ----------------------------------------------------------

  if (!api_key) {
    return jsonResponse(
      {
        error: "api_key is required",
      },
      400
    );
  }

  const cleanQuestion =
    String(question).trim();

  if (!cleanQuestion) {
    return jsonResponse(
      {
        error: "Question cannot be empty",
      },
      400
    );
  }

  // ----------------------------------------------------------
  // CONTEXT
  // ----------------------------------------------------------

  const context = {
    userId: String(user_id),
    applicationId: String(application_id),
    conversationId: String(conversation_id),
    apiKey: String(api_key),
  };

  console.log(
    "CHAT REQUEST",
    {
      applicationId: context.applicationId,
      conversationId: context.conversationId,
      question: cleanQuestion,
    }
  );


  // ==========================================================
  // STEP 1 — SARVAM 105B PLANNER
  // ==========================================================

  let rawPlan;

  try {
    rawPlan = await createDataPlan(
      env,
      cleanQuestion
    );
  } catch (error) {
    console.error(
      "SARVAM PLANNER ERROR:",
      error?.message || String(error)
    );

    return jsonResponse(
      {
        error:
          "I couldn't understand the data needed for this question.",
        details:
          error?.message || String(error),
      },
      502
    );
  }


  // ==========================================================
  // STEP 2 — VALIDATE SARVAM PLAN
  // ==========================================================

  let plan;

  try {
    plan = validatePlan(rawPlan);
  } catch (error) {
    console.error(
      "DATA PLAN VALIDATION ERROR:",
      error?.message || String(error),
      rawPlan
    );

    return jsonResponse(
      {
        error:
          "The AI generated an invalid data request.",
      },
      500
    );
  }


  console.log(
    "DATA PLAN",
    JSON.stringify(plan)
  );


  // ==========================================================
  // STEP 3 — QUESTION CANNOT BE ANSWERED
  // ==========================================================

  if (!plan.can_answer) {
    const reply =
      "I can't answer that with the data Reportli currently has. " +
      plan.reason;

    try {
      const messageId =
        await findPendingChatMessage(
          env,
          context,
          cleanQuestion
        );

      await saveReply(
        env,
        messageId,
        reply
      );
    } catch (error) {
      console.error(
        "SAVE UNSUPPORTED REPLY ERROR:",
        error?.message || String(error)
      );
    }

    return jsonResponse({
      success: true,
      reply,
      plan,
    });
  }


  // ==========================================================
  // STEP 4 — FETCH RELEVANT SUPABASE DATA
  // ==========================================================

  let data;

  try {
    data = await executeDataPlan(
      env,
      plan,
      context
    );
  } catch (error) {
    console.error(
      "SUPABASE DATA ERROR:",
      error?.message || String(error)
    );

    return jsonResponse(
      {
        error:
          "I couldn't retrieve the SaaS data needed to answer that.",
        details:
          error?.message || String(error),
      },
      502
    );
  }


  // ==========================================================
  // STEP 5 — SARVAM 105B ANALYST
  // ==========================================================

  let reply;

  try {
    reply = await generateFinalAnswer(
      env,
      cleanQuestion,
      data,
      context
    );
  } catch (error) {
    console.error(
      "SARVAM ANALYST ERROR:",
      error?.message || String(error)
    );

    return jsonResponse(
      {
        error:
          "I retrieved the data, but I couldn't analyze it right now.",
        details:
          error?.message || String(error),
      },
      502
    );
  }


  // ==========================================================
  // STEP 6 — SAVE REPLY TO chat_messages
  // ==========================================================

  try {
    const messageId =
      await findPendingChatMessage(
        env,
        context,
        cleanQuestion
      );

    await saveReply(
      env,
      messageId,
      reply
    );
  } catch (error) {
    console.error(
      "SAVE REPLY ERROR:",
      error?.message || String(error)
    );

    // We still return the answer to the frontend.
    // Saving failure should not destroy a successful AI response.
  }


  // ==========================================================
  // STEP 7 — RETURN TO FRONTEND
  // ==========================================================

  return jsonResponse({
    success: true,
    reply,
  });
}


// ============================================================
// HEALTH CHECK
// ============================================================

async function handleHealth() {
  return jsonResponse({
    ok: true,
    service: "reportli-ai-chat",
    model: SARVAM_MODEL,
    timestamp: new Date().toISOString(),
  });
}


// ============================================================
// CLOUDFLARE WORKER ENTRY POINT
// ============================================================

export default {
  async fetch(request, env) {
    // --------------------------------------------------------
    // CORS PREFLIGHT
    // --------------------------------------------------------

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }


    // --------------------------------------------------------
    // URL
    // --------------------------------------------------------

    const url = new URL(request.url);


    // --------------------------------------------------------
    // HEALTH
    // --------------------------------------------------------

    if (
      request.method === "GET" &&
      url.pathname === "/"
    ) {
      return handleHealth();
    }


    if (
      request.method === "GET" &&
      url.pathname === "/health"
    ) {
      return handleHealth();
    }


    // --------------------------------------------------------
    // CHAT
    // --------------------------------------------------------

    if (
      request.method === "POST" &&
      url.pathname === "/chat"
    ) {
      try {
        return await handleChat(
          request,
          env
        );
      } catch (error) {
        console.error(
          "UNHANDLED CHAT ERROR:",
          error?.message || String(error),
          error?.stack
        );

        return jsonResponse(
          {
            error:
              "Something went wrong while processing the chat request.",
          },
          500
        );
      }
    }


    // --------------------------------------------------------
    // 404
    // --------------------------------------------------------

    return jsonResponse(
      {
        error: "Not found",
      },
      404
    );
  },
};
