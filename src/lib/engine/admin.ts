/* ------------------------------------------------------------------ */
/*  Admin access for API routes                                        */
/*                                                                     */
/*  A signed-in user is an admin when their id is in app_admins (added */
/*  by SQL only, see docs/HUMAN_ACTIONS.md). Every /api/admin route     */
/*  calls requireAdmin() first.                                         */
/* ------------------------------------------------------------------ */

import type { NextRequest } from "next/server";
import { ApiError, requireUser } from "@/lib/supabase/server";
import { getEngine } from "./server";

export async function requireAdmin(req: NextRequest): Promise<{ userId: string }> {
  const { userId } = await requireUser(req);
  const { rt } = getEngine();
  if (!(await rt.store.isAdmin(userId))) throw new ApiError(403, "Admins only.");
  return { userId };
}
