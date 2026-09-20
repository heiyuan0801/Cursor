export interface ClientKeyInfo {
  id: string;
  label: string;
  hint: string;
  createdAt: string;
}

export function sessionCookie(
  token: string,
  maxAge = 60 * 60 * 24 * 7,
): string {
  return `cursor2api_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

export function sessionToken(request: Request): string {
  const raw = request.headers.get("cookie") || "";
  const match = /(?:^|;\s*)cursor2api_session=([^;]+)/.exec(raw);
  try {
    return match ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}
