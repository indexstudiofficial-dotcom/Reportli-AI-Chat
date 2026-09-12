// ============================================================
// REPORTLI AI — CHAT WORKER
// ============================================================

export default {
  async fetch(request, env) {

    // --------------------------------------------------------
    // CORS
    // --------------------------------------------------------

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    // --------------------------------------------------------
    // URL
    // --------------------------------------------------------

    const url = new URL(request.url);

    // --------------------------------------------------------
    // HEALTH CHECK
    // --------------------------------------------------------

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        success: true,
        message: "Reportli Chat Worker is running"
      });
    }

    // --------------------------------------------------------
    // CHAT ROUTE
    // --------------------------------------------------------

    if (request.method === "POST" && url.pathname === "/chat") {

      try {

        // ----------------------------------------------------
        // READ REQUEST
        // ----------------------------------------------------

        const body = await request.json();

        const {
          user_id,
          application_id,
          conversation_id,
          question
        } = body;

        // ----------------------------------------------------
        // VALIDATION
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

        if (!question) {
          return json({
            success: false,
            error: "question is required"
          }, 400);
        }

        // ----------------------------------------------------
        // TEST AI REPLY
        // ----------------------------------------------------

        const reply =
          "Test successful. Your question was saved to Reportli.";

        // ----------------------------------------------------
        // CREATE MESSAGE ID
        // ----------------------------------------------------

        const messageId = `msg_${crypto.randomUUID()}`;

        // ----------------------------------------------------
        // INSERT INTO SUPABASE
        // ----------------------------------------------------

        const supabaseResponse = await fetch(
          `${env.SUPABASE_URL}/rest/v1/chat_messages`,
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",

              // Supabase API key
              "apikey": env.SUPABASE_SERVICE_ROLE_KEY,

              // Authorization
              "Authorization":
                `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

              // Ask Supabase to return the inserted row
              "Prefer": "return=representation"
            },

            body: JSON.stringify({
              id: messageId,
              user_id: user_id,
              application_id: application_id,
              conversation_id: conversation_id,
              role: "AI",
              question: question,
              reply: reply
            })
          }
        );

        // ----------------------------------------------------
        // READ SUPABASE RESPONSE
        // ----------------------------------------------------

        const supabaseText =
          await supabaseResponse.text();

        // ----------------------------------------------------
        // SUPABASE ERROR
        // ----------------------------------------------------

        if (!supabaseResponse.ok) {

          return json({
            success: false,
            error: "Supabase insert failed",
            supabase_status: supabaseResponse.status,
            details: supabaseText
          }, 500);
        }

        // ----------------------------------------------------
        // PARSE SAVED MESSAGE
        // ----------------------------------------------------

        let savedMessage;

        try {
          savedMessage = JSON.parse(supabaseText);
        } catch {
          savedMessage = supabaseText;
        }

        // ----------------------------------------------------
        // SUCCESS
        // ----------------------------------------------------

        return json({
          success: true,
          message: savedMessage
        });

      } catch (error) {

        // ----------------------------------------------------
        // WORKER ERROR
        // ----------------------------------------------------

        return json({
          success: false,
          error: error.message
        }, 500);
      }
    }

    // --------------------------------------------------------
    // UNKNOWN ROUTE
    // --------------------------------------------------------

    return json({
      success: false,
      error: "Method not allowed",
      method: request.method,
      path: url.pathname
    }, 405);
  }
};


// ============================================================
// JSON RESPONSE HELPER
// ============================================================

function json(data, status = 200) {

  return new Response(
    JSON.stringify(data),

    {
      status: status,

      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    }
  );
                    }
