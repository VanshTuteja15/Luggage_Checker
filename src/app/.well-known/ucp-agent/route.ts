import profile from "../../../../ucp/agent-profile.json";

/**
 * GET /.well-known/ucp-agent — our public UCP agent profile.
 *
 * Shopify's Catalog MCP requires every call to carry a URL identifying the
 * agent. Once the app is deployed, UCP_AGENT_PROFILE_URL points here. The
 * profile declares catalog search and lookup only: no cart, checkout or
 * payment.
 */
export const dynamic = "force-static";

export function GET() {
  return new Response(JSON.stringify(profile, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
