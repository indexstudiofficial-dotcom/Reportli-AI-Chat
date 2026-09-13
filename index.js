// ============================================================
// REPORTLI AI - INTELLIGENT CHAT WORKER
// ============================================================
//
// FLOW:
//
// User question
//      ↓
// Cloudflare Worker
//      ↓
// SARVAM 105B - PLANNER
//      ↓
// Understand question
//      ↓
// Select required tables + columns
//      ↓
// Worker validates AI plan
//      ↓
// Supabase
//      ↓
// Relevant data
//      ↓
// SARVAM 105B - ANALYST
//      ↓
// Final answer
//      ↓
// Save answer to chat_messages
//      ↓
// Return answer
//
// ============================================================
//
// CURRENT DATA:
//
// chat_messages
// user_activity
// errors
//
// CURRENT ANALYTICS WINDOW:
//
// Last 7 days
//
// REQUIRED CLOUDFLARE SECRETS:
//
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
// SARVAM_API_KEY
//
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

const SARVAM_URL =
  "https://api.sarvam.ai/v1/chat/completions";

const SARVAM_MODEL =
  "sarvam-105b";

const MAX_ROWS_PER_TABLE =
  5000;


// ============================================================
// ALLOWED DATABASE SCHEMA
// ============================================================
//
// IMPORTANT:
//
// Sarvam can ONLY choose from these tables and columns.
//
// Never allow the AI to generate arbitrary SQL.
//
// ============================================================

const DATABASE_SCHEMA = {

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


// ============================================================
// CORS
// ============================================================

function corsHeaders() {

  return {

    "Access-Control-Allow-Origin": "*",

    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type, Authorization",

    "Content-Type":
      "application/json",

  };

}


// ============================================================
// JSON RESPONSE
// ============================================================

function json(data, status = 200) {

  return new Response(

    JSON.stringify(data),

    {
      status,

      headers:
        corsHeaders(),
    }

  );

}


// ============================================================
// DATE
// ============================================================

function getSevenDaysAgo() {

  const date =
    new Date();

  date.setUTCDate(
    date.getUTCDate() - 7
  );

  return date.toISOString();

}


// ============================================================
// SUPABASE REQUEST
// ============================================================

async function supabaseRequest(
  env,
  path,
  options = {}
) {

  const url =
    `${env.SUPABASE_URL}${path}`;

  const headers = {

    "apikey":
      env.SUPABASE_SERVICE_ROLE_KEY,

    "Authorization":
      `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

    "Content-Type":
      "application/json",

    ...(options.headers || {}),

  };


  const response =
    await fetch(

      url,

      {
        ...options,
        headers,
      }

    );


  const text =
    await response.text();


  let data;

  try {

    data =
      text
        ? JSON.parse(text)
        : null;

  } catch {

    data =
      text;

  }


  if (!response.ok) {

    throw new Error(

      `Supabase HTTP ${response.status}: ${
        typeof data === "string"
          ? data
          : JSON.stringify(data)
      }`

    );

  }


  return data;

}


// ============================================================
// SARVAM REQUEST
// ============================================================

async function sarvamRequest(
  env,
  messages,
  options = {}
) {

  if (!env.SARVAM_API_KEY) {

    throw new Error(
      "SARVAM_API_KEY is missing."
    );

  }


  const body = {

    model:
      SARVAM_MODEL,

    messages,

    temperature:
      options.temperature ?? 0.1,

    max_tokens:
      options.max_tokens ?? 3000,

    reasoning_effort:
      options.reasoning_effort ?? "medium",

    stream:
      false,

  };


  // ----------------------------------------------------------
  // Structured output
  // ----------------------------------------------------------

  if (options.response_format) {

    body.response_format =
      options.response_format;

  }


  const response =
    await fetch(

      SARVAM_URL,

      {

        method:
          "POST",

        headers: {

          "Content-Type":
            "application/json",

          "api-subscription-key":
            env.SARVAM_API_KEY,

          "Authorization":
            `Bearer ${env.SARVAM_API_KEY}`,

        },

        body:
          JSON.stringify(body),

      }

    );


  const text =
    await response.text();


  let data;

  try {

    data =
      text
        ? JSON.parse(text)
        : null;

  } catch {

    data =
      text;

  }


  if (!response.ok) {

    console.error(
      "SARVAM ERROR:",
      JSON.stringify({
        status:
          response.status,

        body:
          data,
      })
    );


    throw new Error(

      `Sarvam API HTTP ${response.status}: ${
        typeof data === "string"
          ? data
          : JSON.stringify(data)
      }`

    );

  }


  const content =
    data?.choices?.[0]?.message?.content;


  if (
    typeof content !== "string" ||
    !content.trim()
  ) {

    throw new Error(

      `Sarvam returned no content: ${JSON.stringify(data)}`

    );

  }


  return content.trim();

}


// ============================================================
// EXTRACT JSON
// ============================================================
//
// Safety fallback in case the model returns JSON wrapped
// inside markdown despite response_format.
//
// ============================================================

function extractJSON(text) {

  if (
    typeof text !== "string"
  ) {

    throw new Error(
      "Expected JSON text from Sarvam."
    );

  }


  // Direct JSON
  try {

    return JSON.parse(
      text
    );

  } catch {}


  // Remove markdown fences
  const cleaned =
    text
      .replace(
        /^```json\s*/i,
        ""
      )
      .replace(
        /^```\s*/i,
        ""
      )
      .replace(
        /\s*```$/i,
        ""
      )
      .trim();


  try {

    return JSON.parse(
      cleaned
    );

  } catch {}


  throw new Error(
    `Sarvam returned invalid JSON: ${text}`
  );

}


// ============================================================
// VALIDATE TABLE
// ============================================================

function isAllowedTable(
  table
) {

  return Object.prototype
    .hasOwnProperty.call(
      DATABASE_SCHEMA,
      table
    );

}


// ============================================================
// VALIDATE COLUMN
// ============================================================

function isAllowedColumn(
  table,
  column
) {

  if (
    !isAllowedTable(table)
  ) {

    return false;

  }


  return DATABASE_SCHEMA[table]
    .includes(column);

}


// ============================================================
// VALIDATE SARVAM PLAN
// ============================================================

function validatePlan(
  plan
) {

  if (
    !plan ||
    typeof plan !== "object"
  ) {

    throw new Error(
      "Invalid Sarvam data plan."
    );

  }


  if (
    plan.type !== "data_query" &&
    plan.type !== "conversation_query" &&
    plan.type !== "general"
  ) {

    throw new Error(
      "Sarvam returned an unsupported plan type."
    );

  }


  // General question needs no database
  if (
    plan.type === "general"
  ) {

    return {
      type:
        "general",

      tables: [],

      time_range:
        "last_7_days",
    };

  }


  if (
    !Array.isArray(plan.tables)
  ) {

    throw new Error(
      "Sarvam plan does not contain tables."
    );

  }


  const validatedTables = [];


  for (
    const tablePlan
    of plan.tables
  ) {

    const table =
      tablePlan?.table;


    if (
      !isAllowedTable(table)
    ) {

      throw new Error(
        `Sarvam requested forbidden table: ${table}`
      );

    }


    if (
      !Array.isArray(
        tablePlan.columns
      )
    ) {

      throw new Error(
        `No columns provided for ${table}.`
      );

    }


    const columns = [];


    for (
      const column
      of tablePlan.columns
    ) {

      if (
        !isAllowedColumn(
          table,
          column
        )
      ) {

        throw new Error(
          `Sarvam requested forbidden column: ${table}.${column}`
        );

      }


      if (
        !columns.includes(column)
      ) {

        columns.push(column);

      }

    }


    if (
      columns.length === 0
    ) {

      throw new Error(
        `No valid columns requested for ${table}.`
      );

    }


    validatedTables.push({

      table,

      columns,

    });

  }


  return {

    type:
      plan.type,

    tables:
      validatedTables,

    time_range:
      plan.time_range ===
      "last_7_days"

        ? "last_7_days"

        : "last_7_days",

  };

}


// ============================================================
// SARVAM PLANNER
// ============================================================
//
// This is the FIRST AI call.
//
// Sarvam understands the founder's question and decides
// which data is necessary.
//
// ============================================================

async function createDataPlan(
  env,
  question
) {

  const schemaText = `

TABLE: chat_messages

COLUMNS:
${DATABASE_SCHEMA.chat_messages.join(", ")}


TABLE: user_activity

COLUMNS:
${DATABASE_SCHEMA.user_activity.join(", ")}


TABLE: errors

COLUMNS:
${DATABASE_SCHEMA.errors.join(", ")}

`;


  const systemPrompt = `

You are the DATA PLANNER for Reportli AI.

Reportli AI is an AI co-founder for SaaS founders.

Your job is NOT to answer the founder's question.

Your job is to understand the question and determine exactly which database tables and columns are required to answer it.

AVAILABLE DATABASE SCHEMA:

${schemaText}

IMPORTANT RULES:

1. You may ONLY choose tables listed in the schema.

2. You may ONLY choose columns listed for those tables.

3. NEVER invent a table.

4. NEVER invent a column.

5. NEVER generate SQL.

6. NEVER generate a Supabase URL.

7. NEVER request a secret, API key or password.

8. Analytics data is limited to the LAST 7 DAYS.

9. The user_activity table contains SaaS activity.

10. user_activity.session_id represents a session.

11. user_activity.event contains event information as JSONB.

12. errors contains SaaS error information.

13. chat_messages contains the founder's previous Reportli conversations.

14. Do NOT use chat_messages for SaaS activity unless the founder specifically asks about previous Reportli conversations.

15. Do NOT assume session_id equals a unique customer/user.

16. Do NOT request user_activity.user_id to identify customers. It is not reliable customer identity for analytics.

17. Request the minimum columns necessary.

EXAMPLES:

Question:
"How many sessions did I have?"

Plan:
user_activity.session_id
user_activity.time

Question:
"What events happened most frequently?"

Plan:
user_activity.event
user_activity.time

Question:
"What is my most common error?"

Plan:
errors.error_message
errors.timestamp

Question:
"When did errors increase?"

Plan:
errors.error_message
errors.timestamp

Question:
"Give me a summary of what happened in my SaaS."

Plan:
user_activity.session_id
user_activity.time
user_activity.event

AND

errors.error_message
errors.timestamp
errors.ai_analysis

Question:
"What did I ask Reportli yesterday?"

Plan:
chat_messages.question
chat_messages.reply
chat_messages.created_at
chat_messages.role

If no database data is required, return type "general".

Always return ONLY the requested JSON structure.

`;


  const userPrompt = `

Founder question:

${question}

Determine the minimum database data required to answer this question.

Return only a data plan.

`;


  const response =
    await sarvamRequest(

      env,

      [

        {
          role:
            "system",

          content:
            systemPrompt,

        },

        {
          role:
            "user",

          content:
            userPrompt,

        },

      ],

      {

        temperature:
          0,

        max_tokens:
          1000,

        reasoning_effort:
          "medium",

        response_format: {

          type:
            "json_schema",

          json_schema: {

            name:
              "reportli_data_plan",

            strict:
              true,

            schema: {

              type:
                "object",

              properties: {

                type: {

                  type:
                    "string",

                  enum: [
                    "data_query",
                    "conversation_query",
                    "general",
                  ],

                },

                tables: {

                  type:
                    "array",

                  items: {

                    type:
                      "object",

                    properties: {

                      table: {
                        type:
                          "string",
                      },

                      columns: {

                        type:
                          "array",

                        items: {
                          type:
                            "string",
                        },

                      },

                    },

                    required: [
                      "table",
                      "columns",
                    ],

                    additionalProperties:
                      false,

                  },

                },

                time_range: {

                  type:
                    "string",

                  enum: [
                    "last_7_days",
                  ],

                },

                reason: {

                  type:
                    "string",

                },

              },

              required: [
                "type",
                "tables",
                "time_range",
                "reason",
              ],

              additionalProperties:
                false,

            },

          },

        },

      }

    );


  const plan =
    extractJSON(
      response
    );


  return validatePlan(
    plan
  );

}


// ============================================================
// SAFE COLUMN SELECT
// ============================================================

function buildSelect(
  columns
) {

  return columns
    .join(",");

}


// ============================================================
// FETCH USER ACTIVITY
// ============================================================

async function fetchUserActivity(
  env,
  apiKey,
  columns,
  sevenDaysAgo
) {

  const select =
    buildSelect(
      columns
    );


  const path =
    `/rest/v1/user_activity` +
    `?api_key=eq.${encodeURIComponent(apiKey)}` +
    `&time=gte.${encodeURIComponent(sevenDaysAgo)}` +
    `&select=${encodeURIComponent(select)}` +
    `&order=time.desc` +
    `&limit=${MAX_ROWS_PER_TABLE}`;


  return await supabaseRequest(
    env,
    path
  );

}


// ============================================================
// FETCH ERRORS
// ============================================================

async function fetchErrors(
  env,
  apiKey,
  columns,
  sevenDaysAgo
) {

  const select =
    buildSelect(
      columns
    );


  const path =
    `/rest/v1/errors` +
    `?api_key=eq.${encodeURIComponent(apiKey)}` +
    `&timestamp=gte.${encodeURIComponent(sevenDaysAgo)}` +
    `&select=${encodeURIComponent(select)}` +
    `&order=timestamp.desc` +
    `&limit=${MAX_ROWS_PER_TABLE}`;


  return await supabaseRequest(
    env,
    path
  );

}


// ============================================================
// FETCH CHAT MESSAGES
// ============================================================

async function fetchChatMessages(
  env,
  userId,
  applicationId,
  columns
) {

  const select =
    buildSelect(
      columns
    );


  const path =
    `/rest/v1/chat_messages` +
    `?user_id=eq.${encodeURIComponent(userId)}` +
    `&application_id=eq.${encodeURIComponent(applicationId)}` +
    `&created_at=gte.${encodeURIComponent(getSevenDaysAgo())}` +
    `&select=${encodeURIComponent(select)}` +
    `&order=created_at.desc` +
    `&limit=${MAX_ROWS_PER_TABLE}`;


  return await supabaseRequest(
    env,
    path
  );

}


// ============================================================
// EXECUTE DATA PLAN
// ============================================================
//
// Sarvam chooses what it needs.
// Worker decides HOW to query it.
//
// ============================================================

async function executeDataPlan(
  env,
  plan,
  application,
  userId,
  applicationId
) {

  const sevenDaysAgo =
    getSevenDaysAgo();


  const result = {

    period:
      "last 7 days",

    tables: {},

  };


  for (
    const tablePlan
    of plan.tables
  ) {

    const {
      table,
      columns,
    } =
      tablePlan;


    // --------------------------------------------------------
    // USER ACTIVITY
    // --------------------------------------------------------

    if (
      table ===
      "user_activity"
    ) {

      const rows =
        await fetchUserActivity(

          env,

          application.api_key,

          columns,

          sevenDaysAgo

        );


      result.tables.user_activity = {

        columns,

        row_count:
          rows.length,

        rows,

      };

      continue;

    }


    // --------------------------------------------------------
    // ERRORS
    // --------------------------------------------------------

    if (
      table ===
      "errors"
    ) {

      const rows =
        await fetchErrors(

          env,

          application.api_key,

          columns,

          sevenDaysAgo

        );


      result.tables.errors = {

        columns,

        row_count:
          rows.length,

        rows,

      };

      continue;

    }


    // --------------------------------------------------------
    // CHAT MESSAGES
    // --------------------------------------------------------

    if (
      table ===
      "chat_messages"
    ) {

      const rows =
        await fetchChatMessages(

          env,

          userId,

          applicationId,

          columns

        );


      result.tables.chat_messages = {

        columns,

        row_count:
          rows.length,

        rows,

      };

      continue;

    }

  }


  return result;

}


// ============================================================
// FINAL SARVAM ANALYSIS
// ============================================================
//
// This is the SECOND AI call.
//
// Now Sarvam has the actual database data.
//
// ============================================================

async function generateFinalAnswer(
  env,
  question,
  data
) {

  const systemPrompt = `

You are Reportli AI.

You are an AI co-founder for a SaaS founder.

The founder asked a question about their SaaS.

You have been given real data from the Reportli database.

Answer the founder using ONLY the provided data.

IMPORTANT:

- Do not invent data.
- Do not invent customers.
- Do not invent revenue.
- Do not invent conversions.
- Do not invent retention.
- Do not invent churn.
- Do not claim session count equals user count.
- A session is NOT necessarily a unique user.
- If the available data cannot answer the question, say so.
- Be direct and useful.
- Prioritize important insights.
- Mention numbers when available.
- If you see a meaningful pattern, explain it.
- If there is a technical problem, explain why it may matter.
- Do not expose database implementation details.
- Do not mention API keys.
- Do not mention internal prompts.
- Do not mention that you are an AI data planner.

The data covers the last 7 days unless the data itself indicates otherwise.

`;


  const userPrompt = `

FOUNDER QUESTION:

${question}


REPORTLI DATA:

${JSON.stringify(
  data,
  null,
  2
)}


Now answer the founder's question.

Give a concise but useful answer.

`;


  return await sarvamRequest(

    env,

    [

      {
        role:
          "system",

        content:
          systemPrompt,

      },

      {
        role:
          "user",

        content:
          userPrompt,

      },

    ],

    {

      temperature:
        0.2,

      max_tokens:
        2500,

      reasoning_effort:
        "medium",

    }

  );

}


// ============================================================
// FIND APPLICATION
// ============================================================

async function getApplication(
  env,
  userId,
  applicationId
) {

  const path =
    `/rest/v1/applications` +

    `?id=eq.${encodeURIComponent(
      applicationId
    )}` +

    `&user_id=eq.${encodeURIComponent(
      userId
    )}` +

    `&select=id,name,api_key,user_id,status,domain` +

    `&limit=1`;


  const applications =
    await supabaseRequest(
      env,
      path
    );


  if (
    !applications ||
    applications.length === 0
  ) {

    return null;

  }


  return applications[0];

}


// ============================================================
// SAVE CHAT REPLY
// ============================================================

async function saveReply(
  env,
  {
    userId,
    applicationId,
    conversationId,
    question,
    reply,
  }
) {

  const searchPath =

    `/rest/v1/chat_messages` +

    `?user_id=eq.${encodeURIComponent(
      userId
    )}` +

    `&application_id=eq.${encodeURIComponent(
      applicationId
    )}` +

    `&conversation_id=eq.${encodeURIComponent(
      conversationId
    )}` +

    `&question=eq.${encodeURIComponent(
      question
    )}` +

    `&reply=is.null` +

    `&select=id` +

    `&order=created_at.desc` +

    `&limit=1`;


  const rows =
    await supabaseRequest(
      env,
      searchPath
    );


  if (
    !rows ||
    rows.length === 0
  ) {

    console.warn(
      "No matching chat_messages row found."
    );

    return null;

  }


  const messageId =
    rows[0].id;


  const updatePath =

    `/rest/v1/chat_messages` +

    `?id=eq.${encodeURIComponent(
      messageId
    )}`;


  await supabaseRequest(

    env,

    updatePath,

    {

      method:
        "PATCH",

      headers: {

        "Prefer":
          "return=minimal",

      },

      body:
        JSON.stringify({
          reply,
        }),

    }

  );


  return messageId;

}


// ============================================================
// MAIN CHAT HANDLER
// ============================================================

async function handleChat(
  request,
  env
) {

  // ----------------------------------------------------------
  // Parse body
  // ----------------------------------------------------------

  let body;

  try {

    body =
      await request.json();

  } catch {

    return json(

      {
        error:
          "Invalid JSON request body.",
      },

      400

    );

  }


  const {
    user_id,
    application_id,
    conversation_id,
    question,
  } = body;


  // ----------------------------------------------------------
  // Validate input
  // ----------------------------------------------------------

  if (
    !user_id ||
    !application_id ||
    !conversation_id ||
    !question
  ) {

    return json(

      {
        error:
          "Missing user_id, application_id, conversation_id or question.",
      },

      400

    );

  }


  if (
    typeof question !== "string" ||
    !question.trim()
  ) {

    return json(

      {
        error:
          "Question must be a non-empty string.",
      },

      400

    );

  }


  const cleanQuestion =
    question.trim();


  // ----------------------------------------------------------
  // Validate application
  // ----------------------------------------------------------

  const application =
    await getApplication(

      env,

      user_id,

      application_id

    );


  if (!application) {

    return json(

      {
        error:
          "Application not found or does not belong to this user.",
      },

      404

    );

  }


  if (
    !application.api_key
  ) {

    return json(

      {
        error:
          "Application does not have an API key.",
      },

      400

    );

  }


  // ==========================================================
  // STEP 1
  // SARVAM UNDERSTANDS THE QUESTION
  // ==========================================================

  let plan;

  try {

    plan =
      await createDataPlan(

        env,

        cleanQuestion

      );

  } catch (error) {

    console.error(
      "SARVAM PLANNER ERROR:",
      error
    );


    return json(

      {
        error:
          "Reportli could not understand the question.",

        details:
          error?.message ||
          "Unknown planner error.",

        model:
          SARVAM_MODEL,

      },

      502

    );

  }


  // ==========================================================
  // STEP 2
  // GENERAL QUESTION
  // ==========================================================

  if (
    plan.type ===
    "general"
  ) {

    let reply;

    try {

      reply =
        await generateFinalAnswer(

          env,

          cleanQuestion,

          {
            period:
              "last 7 days",

            tables: {},

          }

        );

    } catch (error) {

      console.error(
        "SARVAM FINAL ERROR:",
        error
      );


      return json(

        {
          error:
            "Reportli AI failed to generate an answer.",

          details:
            error?.message,

          model:
            SARVAM_MODEL,

        },

        502

      );

    }


    try {

      await saveReply(

        env,

        {
          userId:
            user_id,

          applicationId:
            application_id,

          conversationId:
            conversation_id,

          question:
            cleanQuestion,

          reply,

        }

      );

    } catch (error) {

      console.error(
        "SAVE REPLY ERROR:",
        error
      );

    }


    return json({

      success:
        true,

      reply,

      model:
        SARVAM_MODEL,

    });

  }


  // ==========================================================
  // STEP 3
  // EXECUTE SARVAM DATA PLAN
  // ==========================================================

  let data;

  try {

    data =
      await executeDataPlan(

        env,

        plan,

        application,

        user_id,

        application_id

      );

  } catch (error) {

    console.error(
      "SUPABASE DATA ERROR:",
      error
    );


    return json(

      {
        error:
          "Reportli could not retrieve the required data.",

        details:
          error?.message,

      },

      502

    );

  }


  // ==========================================================
  // STEP 4
  // SARVAM ANALYZES REAL DATA
  // ==========================================================

  let reply;

  try {

    reply =
      await generateFinalAnswer(

        env,

        cleanQuestion,

        data

      );

  } catch (error) {

    console.error(
      "SARVAM ANALYSIS ERROR:",
      error
    );


    return json(

      {
        error:
          "Reportli AI failed to analyze the data.",

        details:
          error?.message,

        model:
          SARVAM_MODEL,

      },

      502

    );

  }


  // ==========================================================
  // STEP 5
  // SAVE ANSWER
  // ==========================================================

  let messageId =
    null;


  try {

    messageId =
      await saveReply(

        env,

        {
          userId:
            user_id,

          applicationId:
            application_id,

          conversationId:
            conversation_id,

          question:
            cleanQuestion,

          reply,

        }

      );

  } catch (error) {

    console.error(
      "SAVE REPLY ERROR:",
      error
    );

  }


  // ==========================================================
  // STEP 6
  // RETURN ANSWER
  // ==========================================================

  return json({

    success:
      true,

    reply,

    message_id:
      messageId,

    model:
      SARVAM_MODEL,

    plan: {

      type:
        plan.type,

      tables:
        plan.tables.map(
          item => ({
            table:
              item.table,

            columns:
              item.columns,
          })
        ),

      time_range:
        plan.time_range,

    },

  });

}


// ============================================================
// CLOUDFLARE WORKER
// ============================================================

export default {

  async fetch(
    request,
    env
  ) {

    // --------------------------------------------------------
    // OPTIONS
    // --------------------------------------------------------

    if (
      request.method ===
      "OPTIONS"
    ) {

      return new Response(

        null,

        {
          status:
            204,

          headers:
            corsHeaders(),

        }

      );

    }


    const url =
      new URL(
        request.url
      );


    // --------------------------------------------------------
    // HEALTH CHECK
    // --------------------------------------------------------

    if (
      request.method ===
        "GET" &&
      url.pathname === "/"
    ) {

      return json({

        service:
          "Reportli AI Chat Worker",

        status:
          "online",

        model:
          SARVAM_MODEL,

        architecture:
          "Sarvam Planner → Supabase → Sarvam Analyst",

        period:
          "last 7 days",

      });

    }


    // --------------------------------------------------------
    // CHAT
    // --------------------------------------------------------

    if (
      request.method ===
        "POST" &&
      url.pathname === "/chat"
    ) {

      try {

        return await handleChat(

          request,

          env

        );

      } catch (error) {

        console.error(
          "UNHANDLED WORKER ERROR:",
          error
        );


        return json(

          {
            error:
              "Reportli AI service failed.",

            details:
              error?.message ||
              "Unknown Worker error.",

          },

          500

        );

      }

    }


    // --------------------------------------------------------
    // 404
    // --------------------------------------------------------

    return json(

      {
        error:
          "Route not found.",
      },

      404

    );

  },

};
