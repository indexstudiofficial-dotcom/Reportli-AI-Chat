// ============================================================
// REPORTLI AI — CHAT WORKER
// ============================================================

export default {
  async fetch(request, env) {

    // ========================================================
    // CORS
    // ========================================================

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }


    // ========================================================
    // URL
    // ========================================================

    const url = new URL(request.url);


    // ========================================================
    // HEALTH CHECK
    // ========================================================

    if (request.method === "GET" && url.pathname === "/") {

      return json({
        success: true,
        message: "Reportli Chat Worker is running"
      });

    }


    // ========================================================
    // CHAT
    // ========================================================

    if (request.method === "POST" && url.pathname === "/chat") {

      try {

        // ----------------------------------------------------
        // Read request body
        // ----------------------------------------------------

        const body = await request.json();

        const {
          user_id,
          application_id,
          conversation_id,
          question
        } = body;


        // ----------------------------------------------------
        // Validate request
        // ----------------------------------------------------

        if (!user_id) {
          return json({
            success: false,
            error: "user_id is required"
          }, 400);
        }

        if (!application_id) {
          return json({
            success: false,
            error: "application_id is required"
          }, 400);
        }

        if (!conversation_id) {
          return json({
            success: false,
            error: "conversation_id is required"
          }, 400);
        }

        if (!question || !question.trim()) {
          return json({
            success: false,
            error: "question is required"
          }, 400);
        }


        // ====================================================
        // CLEAN QUESTION
        // ====================================================

        const cleanQuestion = question.trim();


        // ====================================================
        // GENERATE AI REPLY
        // ====================================================

        // ----------------------------------------------------
        // TEMPORARY TEST REPLY
        // ----------------------------------------------------
        //
        // Replace this with your real AI call later.
        //

        const reply =
          `I received your question: "${cleanQuestion}"`;


        // ====================================================
        // FIND EXISTING QUESTION ROW
        // ====================================================

        // The FRONTEND already creates the question row.
        //
        // This Worker does NOT create another row.
        //
        // We find the existing row using:
        //
        // user_id
        // application_id
        // conversation_id
        // question
        //
        // And we only select rows where reply is NULL.
        //

        const params = new URLSearchParams();

        params.set(
          "user_id",
          `eq.${user_id}`
        );

        params.set(
          "application_id",
          `eq.${application_id}`
        );

        params.set(
          "conversation_id",
          `eq.${conversation_id}`
        );

        params.set(
          "question",
          `eq.${cleanQuestion}`
        );

        params.set(
          "reply",
          "is.null"
        );

        params.set(
          "select",
          "id,user_id,application_id,conversation_id,role,question,reply,created_at"
        );

        params.set(
          "order",
          "created_at.desc"
        );

        params.set(
          "limit",
          "1"
        );


        // ====================================================
        // FIND QUESTION IN SUPABASE
        // ====================================================

        const findResponse = await fetch(

          `${env.SUPABASE_URL}/rest/v1/chat_messages?${params.toString()}`,

          {
            method: "GET",

            headers: {

              "apikey":
                env.SUPABASE_SERVICE_ROLE_KEY,

              "Authorization":
                `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`

            }
          }

        );


        // ====================================================
        // READ FIND RESPONSE
        // ====================================================

        const findText =
          await findResponse.text();


        // ====================================================
        // FIND ERROR
        // ====================================================

        if (!findResponse.ok) {

          return json({

            success: false,

            error:
              "Failed to find existing question",

            supabase_status:
              findResponse.status,

            details:
              findText

          }, 500);

        }


        // ====================================================
        // PARSE QUESTION ROWS
        // ====================================================

        let questionRows;

        try {

          questionRows =
            JSON.parse(findText);

        } catch {

          questionRows = [];

        }


        // ====================================================
        // QUESTION ROW NOT FOUND
        // ====================================================

        if (
          !Array.isArray(questionRows) ||
          questionRows.length === 0
        ) {

          return json({

            success: false,

            error:
              "Existing question row was not found"

          }, 404);

        }


        // ====================================================
        // GET EXISTING MESSAGE ID
        // ====================================================

        const existingMessage =
          questionRows[0];

        const messageId =
          existingMessage.id;


        // ====================================================
        // VALIDATE MESSAGE ID
        // ====================================================

        if (!messageId) {

          return json({

            success: false,

            error:
              "Existing question row has no message ID"

          }, 500);

        }


        // ====================================================
        // UPDATE EXISTING ROW
        // ====================================================

        // IMPORTANT:
        //
        // We are PATCHING the existing row.
        //
        // We are NOT inserting a new row.
        //
        // Only the "reply" column is updated.
        //

        const updateResponse = await fetch(

          `${env.SUPABASE_URL}/rest/v1/chat_messages?id=eq.${encodeURIComponent(messageId)}`,

          {
            method: "PATCH",

            headers: {

              "Content-Type":
                "application/json",

              "apikey":
                env.SUPABASE_SERVICE_ROLE_KEY,

              "Authorization":
                `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

              "Prefer":
                "return=representation"

            },

            body: JSON.stringify({

              reply: reply

            })

          }

        );


        // ====================================================
        // READ UPDATE RESPONSE
        // ====================================================

        const updateText =
          await updateResponse.text();


        // ====================================================
        // UPDATE ERROR
        // ====================================================

        if (!updateResponse.ok) {

          return json({

            success: false,

            error:
              "Failed to update AI reply",

            supabase_status:
              updateResponse.status,

            details:
              updateText

          }, 500);

        }


        // ====================================================
        // PARSE UPDATED ROW
        // ====================================================

        let updatedMessage;

        try {

          updatedMessage =
            JSON.parse(updateText);

        } catch {

          updatedMessage =
            updateText;

        }


        // ====================================================
        // SUCCESS
        // ====================================================

        return json({

          success: true,

          reply: reply,

          message: updatedMessage

        });


      } catch (error) {

        // ====================================================
        // GENERAL ERROR
        // ====================================================

        return json({

          success: false,

          error:
            error.message || "Unknown error"

        }, 500);

      }

    }


    // ========================================================
    // UNKNOWN ROUTE
    // ========================================================

    return json({

      success: false,

      error: "Method not allowed",

      method: request.method,

      path: url.pathname

    }, 405);

  }
};


// ============================================================
// CORS HEADERS
// ============================================================

function corsHeaders() {

  return {

    "Access-Control-Allow-Origin": "*",

    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type",

    "Content-Type":
      "application/json"

  };

}


// ============================================================
// JSON RESPONSE
// ============================================================

function json(data, status = 200) {

  return new Response(

    JSON.stringify(data),

    {

      status: status,

      headers: corsHeaders()

    }

  );

      }
