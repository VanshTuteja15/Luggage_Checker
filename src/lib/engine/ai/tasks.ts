/* ------------------------------------------------------------------ */
/*  The AI tasks (luggage), each with its rules answer and evidence    */
/*                                                                     */
/*  Measured on our labelled sets (planning/v4/review/02): rules win   */
/*  attributes, terms, titles, queries and promotions outright, so the  */
/*  model is only ever a fallback or an advisor, behind a flag that is  */
/*  off by default:                                                     */
/*    attributes    fills what spec rules couldn't read; every number   */
/*                  must be in the text (unit-aware)                    */
/*    match_judge   an opinion on a near-match pair for the review      */
/*                  queue; it never merges, and hard vetoes override it */
/*    terms         quotes the clauses about automated access for the   */
/*                  owner's read; a quote not found verbatim is dropped */
/* ------------------------------------------------------------------ */

import { z } from "zod/v4";
import { extractAttributes, type AttributeFields } from "../extract/attributes";
import { hardVeto as pairVeto } from "../identity/match";
import { luggagePack } from "../packs/luggage";
import { numberEvidence, quoteEvidence, wordEvidence, type Dropped } from "./evidence";
import { fence, guardedSystem } from "./guard";
import type { AiTask } from "./run";

/* ── attributes ───────────────────────────────────────────────────── */

export type AttributesInput = { title: string; text: string };

const attributesSchema = z.object({
  dimsCm: z.array(z.number().min(1).max(250)).length(3).nullable(),
  capacityL: z.number().min(1).max(300).nullable(),
  weightKg: z.number().min(0.05).max(40).nullable(),
  wheels: z.union([z.literal(2), z.literal(4)]).nullable(),
  // Only "true" or nothing: a page that doesn't say "expandable" isn't proof it isn't.
  expandable: z.literal(true).nullable(),
});
export type AttributesOutput = z.infer<typeof attributesSchema>;

const toOutput = (f: AttributeFields): AttributesOutput => ({
  ...f,
  dimsCm: f.dimsCm ? [...f.dimsCm] : null,
});

export const attributesTask: AiTask<AttributesInput, AttributesOutput> = {
  name: "attributes",
  flag: "ai.attributes",
  schemaVersion: "attributes/1",
  schema: attributesSchema,
  system: guardedSystem(
    `You extract luggage specifications from a product title and description and return JSON.
Fields: dimsCm (the three outside dimensions in cm as stated; if only inches are given multiply by 2.54; null if not stated); capacityL (litres, null if not stated); weightKg (kg; if only lbs divide by 2.2046; null if not stated); wheels (2 for two-wheeled/upright, 4 for spinner/four or double-spinner wheels, null when not stated; a wheel size like "8 cm wheels" is not a count); expandable (true only if the bag itself expands; otherwise null).`,
  ),
  user: (i) => `Title:\n${fence(i.title, 300)}\nDescription:\n${fence(i.text)}`,
  rules: (i) => toOutput(extractAttributes(i.title, i.text).fields),
  evidence: (i, out) => {
    const text = `${i.title} . ${i.text}`;
    const dropped: Dropped[] = [];
    const value: AttributesOutput = { ...out };
    if (out.dimsCm) {
      const bad = out.dimsCm.map((v) => numberEvidence(v, "cm", text)).find((e) => !e.ok);
      if (bad && !bad.ok) {
        dropped.push({ field: "dimsCm", value: out.dimsCm, reason: bad.reason });
        value.dimsCm = null;
      }
    }
    for (const [field, unit] of [
      ["capacityL", "l"],
      ["weightKg", "kg"],
    ] as const) {
      const v = out[field];
      if (v === null) continue;
      const e = numberEvidence(v, unit, text);
      if (!e.ok) {
        dropped.push({ field, value: v, reason: e.reason });
        value[field] = null;
      }
    }
    if (out.wheels !== null) {
      const e = wordEvidence(
        out.wheels === 4
          ? [/\bspinner\b/i, /\b(?:four|4)[- ](?:\w+ )?wheel/i]
          : [/\b(?:two|2)[- ]wheel/i, /\bdual-wheel\b/i, /\bupright\b/i],
        text,
      );
      if (!e.ok) {
        dropped.push({ field: "wheels", value: out.wheels, reason: e.reason });
        value.wheels = null;
      }
    }
    if (out.expandable) {
      const e = wordEvidence([/\bexpand(?:able|s|ing)?\b/i, /\bexpansion\b/i], text);
      if (!e.ok) {
        dropped.push({ field: "expandable", value: true, reason: e.reason });
        value.expandable = null;
      }
    }
    return { value, dropped };
  },
};

/* ── match judge (advisory) ───────────────────────────────────────── */

export type JudgeInput = { a: string; b: string; storeA: string; storeB: string };

const judgeSchema = z.object({
  verdict: z.enum(["same", "variant", "different"]),
  reason: z.string().max(200),
});
export type JudgeOutput = z.infer<typeof judgeSchema>;

/** Hard identity rules a model can't overrule (shared with resolution: identity/match.ts). */
export function hardVeto(a: string, b: string): string | null {
  return pairVeto(luggagePack, a, b);
}

export const matchJudgeTask: AiTask<JudgeInput, JudgeOutput> = {
  name: "match_judge",
  flag: "ai.match_judge",
  schemaVersion: "match_judge/1",
  schema: judgeSchema,
  system: guardedSystem(
    `You compare two luggage listing titles and decide if they are the same product. verdict: "same" = the same product (same size, same version, same line; colour equal or named on only one side; titles may be written differently or in French); "variant" = the same product in a different colour; "different" = anything else (another size, other inches, another version like 2.0 vs 3.0, a special edition, extra line words like International, Expandable, Lite, Compact, Business). When unsure, answer "different". reason: one short sentence.`,
  ),
  user: (i) =>
    `Listing A (${i.storeA}):\n${fence(i.a, 300)}\nListing B (${i.storeB}):\n${fence(i.b, 300)}`,
  // Without a model the grey zone stays with a person: no merge.
  rules: () => ({ verdict: "different", reason: "left for a person to decide" }),
  evidence: (i, out) => {
    const veto = out.verdict === "different" ? null : hardVeto(i.a, i.b);
    if (veto)
      return {
        value: { verdict: "different", reason: veto },
        dropped: [{ field: "verdict", value: out.verdict, reason: `hard rule: ${veto}` }],
      };
    return { value: { verdict: out.verdict, reason: out.reason.slice(0, 200) }, dropped: [] };
  },
  numPredict: 120,
};

/* ── terms pre-screen ─────────────────────────────────────────────── */

export type TermsInput = { text: string };

const termsSchema = z.object({
  category: z.enum([
    "prohibits_automated_access",
    "requires_permission",
    "non_commercial_only",
    "none",
  ]),
  quote: z.string().max(300).nullable(),
});
export type TermsOutput = z.infer<typeof termsSchema>;

/** Keyword pre-screen (100% on the 16 recorded excerpts). It quotes; a person decides. */
export function prescreenTerms(text: string): TermsOutput {
  const bot = text.match(
    /\brobots?\b|\bspiders?\b|\bcrawl\w*|\bscrap\w*|\bdata[- ]min\w*|\bbots?\b|automated (?:tools|means|access)|intelligent agents|LLM-driven bots/i,
  );
  if (bot) return { category: "prohibits_automated_access", quote: bot[0] };
  const perm = text.match(/without (?:the )?(?:express )?(?:prior )?written permission/i);
  if (perm) return { category: "requires_permission", quote: perm[0] };
  const nc = text.match(/personal,? non-commercial use(?: only)?/i);
  if (nc) return { category: "non_commercial_only", quote: nc[0] };
  return { category: "none", quote: null };
}

export const termsTask: AiTask<TermsInput, TermsOutput> = {
  name: "terms",
  flag: "ai.terms_prescreen",
  schemaVersion: "terms/1",
  schema: termsSchema,
  system: guardedSystem(
    `You pre-screen a store's terms text for clauses about automated access and reuse, for a person to check. category: prohibits_automated_access (bans robots, spiders, crawlers, scrapers, data mining, bots or automated tools); requires_permission (copying, reproducing or using its content or prices needs written permission); non_commercial_only (content for personal, non-commercial use only); none (says nothing about these). quote: the exact words from the text that justify the category, copied character for character; null for none.`,
  ),
  user: (i) => `Terms excerpt:\n${fence(i.text)}`,
  rules: (i) => prescreenTerms(i.text),
  evidence: (i, out) => {
    if (out.category === "none") return { value: { category: "none", quote: null }, dropped: [] };
    const e = out.quote
      ? quoteEvidence(out.quote, i.text)
      : ({ ok: false, reason: "no quote" } as const);
    if (e.ok) return { value: out, dropped: [] };
    // An unquotable claim isn't evidence: the keyword pre-screen stands.
    return {
      value: prescreenTerms(i.text),
      dropped: [{ field: "quote", value: out.quote, reason: e.reason }],
    };
  },
  numPredict: 160,
};

export const AI_TASKS = {
  attributes: attributesTask,
  match_judge: matchJudgeTask,
  terms: termsTask,
} as const;
export type AiTaskName = keyof typeof AI_TASKS;
