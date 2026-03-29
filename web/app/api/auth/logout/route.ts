import { cookies } from "next/headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const cookieStore = await cookies();
  cookieStore.set("gsd-session", "", {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: 0,
    path: "/",
  });
  return Response.json({ ok: true });
}
