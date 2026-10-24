import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { NO_DATABASE, digestDeps, emailRouteError } from "@/lib/digest/server";
import { requireUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const Replace = z.object({ productIds: z.array(z.string().uuid()).max(500) }).strict();
const One = z.object({ productId: z.string().uuid() }).strict();

const NOT_TRACKED = "That product isn't tracked yet, so it can't be added to the email.";

/** PUT /api/email/products: the chosen products, in email order (R1.1). */
export async function PUT(req: NextRequest) {
  try {
    const { userId } = await requireUser(req);
    const parsed = Replace.safeParse(await req.json().catch(() => null));
    if (!parsed.success)
      return NextResponse.json({ error: "That list of products couldn't be read." }, { status: 400 });
    const deps = digestDeps({ req, mailer: null });
    if (!deps) return NextResponse.json({ error: NO_DATABASE }, { status: 503 });
    const chosen = await deps.store.setChosen(userId, parsed.data.productIds);
    return NextResponse.json({ chosen });
  } catch (err) {
    return emailRouteError(err, "PUT /api/email/products", "The products couldn't be saved. Try again.");
  }
}

/** POST /api/email/products: add one tracked product at the end ("Add to morning email", R1.2). */
export async function POST(req: NextRequest) {
  try {
    const { userId } = await requireUser(req);
    const parsed = One.safeParse(await req.json().catch(() => null));
    if (!parsed.success)
      return NextResponse.json({ error: "That product couldn't be read." }, { status: 400 });
    const deps = digestDeps({ req, mailer: null });
    if (!deps) return NextResponse.json({ error: NO_DATABASE }, { status: 503 });
    if (!(await deps.store.addChosen(userId, parsed.data.productId)))
      return NextResponse.json({ error: NOT_TRACKED }, { status: 404 });
    return NextResponse.json({ added: true });
  } catch (err) {
    return emailRouteError(err, "POST /api/email/products", "The product couldn't be added. Try again.");
  }
}

/** DELETE /api/email/products?productId=…: take one product out of the email (Undo). */
export async function DELETE(req: NextRequest) {
  try {
    const { userId } = await requireUser(req);
    const parsed = One.safeParse({ productId: req.nextUrl.searchParams.get("productId") ?? "" });
    if (!parsed.success)
      return NextResponse.json({ error: "That product couldn't be read." }, { status: 400 });
    const deps = digestDeps({ req, mailer: null });
    if (!deps) return NextResponse.json({ error: NO_DATABASE }, { status: 503 });
    await deps.store.removeChosen(userId, parsed.data.productId);
    return NextResponse.json({ removed: true });
  } catch (err) {
    return emailRouteError(err, "DELETE /api/email/products", "The product couldn't be removed. Try again.");
  }
}
