import { getTailscaleStatus, isTailscaleInstalled } from "../../../../../src/web/tailscale.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/tailscale/status
// Returns Tailscale connection status for the settings UI.
// Response shape mirrors the UI's needs: installed, connected, hostname,
// tailnetUrl (the HTTPS URL), and dnsName (the fully-qualified DNS name).
export async function GET(): Promise<Response> {
  try {
    const installed = isTailscaleInstalled();
    if (!installed) {
      return Response.json({
        installed: false,
        connected: false,
        hostname: "",
        tailnetUrl: "",
        dnsName: "",
      });
    }

    const result = getTailscaleStatus();
    if (!result.ok) {
      return Response.json({
        installed: true,
        connected: false,
        hostname: "",
        tailnetUrl: "",
        dnsName: "",
      });
    }

    // result.info.fqdn has the trailing dot already stripped by tailscale.ts
    return Response.json({
      installed: true,
      connected: true,
      hostname: result.info.hostname,
      tailnetUrl: result.info.url,
      dnsName: result.info.fqdn,
    });
  } catch {
    return Response.json({
      installed: false,
      connected: false,
      hostname: "",
      tailnetUrl: "",
      dnsName: "",
    });
  }
}
