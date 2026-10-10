/* ------------------------------------------------------------------ */
/*  Public sign-up switch (R5.1)                                      */
/*                                                                     */
/*  Luggage Depot uses one shared business login, so new accounts are  */
/*  off unless NEXT_PUBLIC_ALLOW_SIGNUP says otherwise. The login page */
/*  reads the same variable to hide its "Create account" tab, and      */
/*  /api/auth/signup refuses on the server. Supabase's own "Allow new  */
/*  users to sign up" setting must also be off (HUMAN_ACTIONS), since  */
/*  the public key could otherwise call Supabase directly.             */
/* ------------------------------------------------------------------ */

/** True only when the variable is explicitly on. Anything else means off. */
export function signupAllowed(
  raw: string | undefined = process.env.NEXT_PUBLIC_ALLOW_SIGNUP,
): boolean {
  return /^(1|true|on|yes)$/i.test((raw ?? "").trim());
}

export const SIGNUP_CLOSED_MESSAGE =
  "New accounts can't be created here. Ask the account owner for the business login.";
