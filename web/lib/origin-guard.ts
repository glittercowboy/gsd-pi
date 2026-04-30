const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"])

export interface OriginRequest {
  headers: Pick<Headers, "get">
  nextUrl: Pick<URL, "protocol">
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    return url.origin
  } catch {
    return null
  }
}

function splitHostHeader(value: string | null): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function originFor(host: string, port: string, protocol = "http:"): string | null {
  return normalizeOrigin(`${protocol}//${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`)
}

function addConfiguredHostOrigins(allowed: Set<string>, host: string, port: string): void {
  const configured = originFor(host, port)
  if (configured) allowed.add(configured)

  const normalizedHost = host.toLowerCase()
  if (!LOOPBACK_HOSTS.has(normalizedHost)) return

  for (const loopbackHost of LOOPBACK_HOSTS) {
    const loopbackOrigin = originFor(loopbackHost, port)
    if (loopbackOrigin) allowed.add(loopbackOrigin)
  }
}

function addIncomingRequestOrigins(allowed: Set<string>, request: OriginRequest, originProtocol: string): void {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim()
  const protocols = new Set<string>([
    forwardedProto ? `${forwardedProto.replace(/:$/, "")}:` : "",
    request.nextUrl.protocol,
    originProtocol,
  ].filter(Boolean))

  for (const host of [
    ...splitHostHeader(request.headers.get("x-forwarded-host")),
    ...splitHostHeader(request.headers.get("host")),
  ]) {
    for (const protocol of protocols) {
      const requestOrigin = normalizeOrigin(`${protocol}//${host}`)
      if (requestOrigin) allowed.add(requestOrigin)
    }
  }
}

export function getAllowedOrigins(request: OriginRequest, origin: string): Set<string> {
  const allowed = new Set<string>()
  const host = process.env.GSD_WEB_HOST || "127.0.0.1"
  const port = process.env.GSD_WEB_PORT || "3000"
  const normalizedOrigin = normalizeOrigin(origin)
  const originProtocol = normalizedOrigin ? new URL(normalizedOrigin).protocol : "http:"

  addConfiguredHostOrigins(allowed, host, port)
  addIncomingRequestOrigins(allowed, request, originProtocol)

  const extra = process.env.GSD_WEB_ALLOWED_ORIGINS
  if (extra) {
    for (const entry of extra.split(",")) {
      const normalized = normalizeOrigin(entry.trim())
      if (normalized) allowed.add(normalized)
    }
  }

  return allowed
}

export function isAllowedOrigin(request: OriginRequest, origin: string): boolean {
  const normalizedOrigin = normalizeOrigin(origin)
  if (!normalizedOrigin) return false
  return getAllowedOrigins(request, normalizedOrigin).has(normalizedOrigin)
}
