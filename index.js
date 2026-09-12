// ============================================================
// REPORTLI AI — CHAT TEST WORKER
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
    // TEST ROUTE
    // --------------------------------------------------------

    if (request.method === "POST" && new URL(request.url).pathname === "/chat") {

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
        // Basic validation
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
        // Create test reply
        // ----------------------------------------------------

        const reply =
          "Test successful. Your question was saved to Reportli.";

        // ----------------------------------------------------
        // Insert into Supabase
        // ----------------------------------------------------

        const response = await fetch(
          `${env.SUPABASE_URL}/rest/v1/chat_messages`,
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",
              "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
              "Prefer": "return=representation"
            },

            body: JSON.stringify({
              id: `msg_${crypto.randomUUID()}`,
              user_id,
              application_id,
              conversation_id,
              role: "AI",
              question,
              reply
            })
          }
        );

        // ----------------------------------------------------
        // Supabase error
        // ----------------------------------------------------

        const responseText = await response.text();

        if (!response.ok) {
          return json({
            success: false,
            error: "Supabase insert failed",
            details: responseText
          }, 500);
        }

        // ----------------------------------------------------
        // Success
        // ----------------------------------------------------

        let savedMessage;

        try {
          savedMessage = JSON.parse(responseText);
        } catch {
          savedMessage = responseText;
        }

        return json({
          success: true,
          message: savedMessage
        });

      } catch (error) {

        return json({
          success: false,
          error: error.message
        }, 500);
      }
    }

    // --------------------------------------------------------
    // Health check
    // --------------------------------------------------------

    if (request.method === "GET") {
      return json({
        success: true,
        message: "Reportli Chat Worker is running"
      });
    }

    return json({
      success: false,
      error: "Method not allowed"
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
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    }
  );
            }
