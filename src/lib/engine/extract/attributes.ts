/* ------------------------------------------------------------------ */
/*  Product attributes from a title + description (rules)              */
/*                                                                     */
/*  Dimensions (cm), capacity (L), weight (kg), wheel positions (2 or   */
/*  4) and "expandable", each with the exact text it came from. Stores  */
/*  write specs in a regular way ("Dimensions: 21.5 x 14.2 x 9 in / 55 x */
/*  36 x 23 cm. Capacity: 26L. Weight: 2.4kg"), and on our labelled set  */
/*  these rules beat every local model (review 02 §3: 95% vs 50–55%).   */
/*  Nothing is guessed: a value the text doesn't state stays null, and  */
/*  absence is never read as "false".                                   */
/* ------------------------------------------------------------------ */

export type AttributeFields = {
  dimsCm: [number, number, number] | null;
  capacityL: number | null;
  weightKg: number | null;
  wheels: 2 | 4 | null;
  expandable: true | null;
};

export type AttributeProvenance = {
  method: "jsonld" | "rules" | "ai";
  evidence: string;
  confidence: number;
  note?: string;
};

export type AttributeResult = {
  fields: AttributeFields;
  provenance: Partial<Record<keyof AttributeFields, AttributeProvenance>>;
};

const NUM = String.raw`(\d+(?:\.\d+)?)`;
const SEP = String.raw`\s*(?:"|''|”|in\.?)?\s*[x×]\s*`;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** "1,903" → "1903"; "16,5" → "16.5". */
function normalise(text: string): string {
  return text
    .replace(/(\d),(\d{3})(?!\d)/g, "$1$2")
    .replace(/(\d),(\d{1,2})(?!\d)/g, "$1.$2")
    .replace(/\s+/g, " ");
}

/** The spec label a dimension triple sits behind, so "Dimensions:" wins over "Laptop Compartment:". */
function dimsAt(
  t: string,
): { dims: [number, number, number]; evidence: string; labelled: boolean } | null {
  const cmRe = new RegExp(
    `${NUM}\\s*[x×]\\s*${NUM}\\s*[x×]\\s*${NUM}(?:\\s*-\\s*\\d+(?:\\.\\d+)?)?\\s*cm\\b`,
    "gi",
  );
  const inRe = new RegExp(
    `${NUM}${SEP}${NUM}${SEP}${NUM}(?:\\s*-\\s*\\d+(?:\\.\\d+)?)?\\s*(?:"|''|”|in\\b|inch(?:es)?\\b)`,
    "gi",
  );
  const label = (at: number) =>
    /(?:^|[.\s])(?:overall |body |case |exterior |outside )?dimensions?(?: \([^)]*\))?\s*:?\s*[^.:]{0,40}$/i.test(
      t.slice(Math.max(0, at - 90), at),
    );
  const avoid = (at: number) =>
    /(?:laptop|tablet|compartment|pocket|interior|internal)[^.:]{0,25}:?\s*[^.:]{0,25}$/i.test(
      t.slice(Math.max(0, at - 40), at),
    );
  const pick = (re: RegExp, toCm: (n: number) => number) => {
    const found: {
      dims: [number, number, number];
      evidence: string;
      labelled: boolean;
      at: number;
    }[] = [];
    for (const m of t.matchAll(re)) {
      const at = m.index ?? 0;
      if (avoid(at)) continue;
      found.push({
        dims: [toCm(Number(m[1])), toCm(Number(m[2])), toCm(Number(m[3]))],
        evidence: m[0].trim(),
        labelled: label(at),
        at,
      });
    }
    return found.find((f) => f.labelled) ?? found[0] ?? null;
  };
  const cm = pick(cmRe, (n) => n);
  if (cm) return cm;
  const inch = pick(inRe, (n) => round2(n * 2.54));
  return inch;
}

function capacityAt(
  title: string,
  t: string,
): { value: number; evidence: string; confidence: number; note?: string } | null {
  const labelled = t.match(
    new RegExp(`(?:capacity|volume)\\s*:?\\s*${NUM}\\s*(?:l\\b|lit(?:er|re)s?\\b)`, "i"),
  );
  const titleL = title.match(new RegExp(`\\b${NUM}\\s*-?\\s*(?:l\\b|lit(?:er|re)s?\\b)\\+?`, "i"));
  const loose = t.match(new RegExp(`\\b${NUM}\\s*-?\\s*(?:l\\b|lit(?:er|re)s?\\b)`, "i"));
  if (labelled) {
    const v = Number(labelled[1]);
    if (titleL && Math.abs(Number(titleL[1]) - v) > 1) {
      return {
        value: v,
        evidence: labelled[0],
        confidence: 0.5,
        note: `the title says ${titleL[0].trim()}`,
      };
    }
    return { value: v, evidence: labelled[0], confidence: 0.9 };
  }
  if (titleL) return { value: Number(titleL[1]), evidence: titleL[0].trim(), confidence: 0.8 };
  if (loose) return { value: Number(loose[1]), evidence: loose[0].trim(), confidence: 0.7 };
  const cuin = t.match(new RegExp(`${NUM}\\s*(?:cu\\.?\\s*in\\.?|in³)`, "i"));
  if (cuin)
    return { value: round2(Number(cuin[1]) * 0.016387), evidence: cuin[0], confidence: 0.7 };
  return null;
}

function weightAt(t: string): { value: number; evidence: string; confidence: number } | null {
  const kgLabelled = t.match(
    new RegExp(`weight\\s*:?\\s*(?:${NUM}\\s*lbs?\\.?\\s*\\/\\s*)?${NUM}\\s*kgs?\\b`, "i"),
  );
  if (kgLabelled) return { value: Number(kgLabelled[2]), evidence: kgLabelled[0], confidence: 0.9 };
  const kgFirst = t.match(new RegExp(`weight\\s*:?\\s*${NUM}\\s*kgs?\\b`, "i"));
  if (kgFirst) return { value: Number(kgFirst[1]), evidence: kgFirst[0], confidence: 0.9 };
  const lb = t.match(new RegExp(`weight\\s*:?\\s*${NUM}\\s*lbs?\\b`, "i"));
  if (lb) return { value: round2(Number(lb[1]) / 2.2046), evidence: lb[0], confidence: 0.85 };
  return null;
}

function wheelsAt(t: string): { value: 2 | 4; evidence: string } | null {
  const two = t.match(/\b(?:two|2)[- ]wheel(?:ed|s)?\b|\bdual-wheel\b/i);
  if (two) return { value: 2, evidence: two[0] };
  const four = t.match(
    /\b(?:four|4)[- ](?:multi-directional |signature |dual |double )?(?:outboard |spinner )?wheel(?:ed|s)?\b/i,
  );
  if (four) return { value: 4, evidence: four[0] };
  const spinner = t.match(/\b(?:double[- ]|dual )?spinner\b/i);
  if (spinner) return { value: 4, evidence: spinner[0] };
  return null;
}

function expandableAt(t: string): string | null {
  for (const m of t.matchAll(/\bexpand(?:able|s|ing)?\b|\bexpansion\b/gi)) {
    const before = t.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
    // "side pockets that expand to hold water bottles" is about a pocket, not the bag.
    if (/pockets?\b[^.]{0,30}$/i.test(before)) continue;
    return m[0];
  }
  return null;
}

export function extractAttributes(title: string, description: string): AttributeResult {
  const t = normalise(`${title} . ${description}`);
  const fields: AttributeFields = {
    dimsCm: null,
    capacityL: null,
    weightKg: null,
    wheels: null,
    expandable: null,
  };
  const provenance: AttributeResult["provenance"] = {};

  const d = dimsAt(t);
  if (d) {
    fields.dimsCm = d.dims;
    provenance.dimsCm = {
      method: "rules",
      evidence: d.evidence,
      confidence: d.labelled ? 0.9 : 0.75,
    };
  }
  const c = capacityAt(normalise(title), t);
  if (c) {
    fields.capacityL = c.value;
    provenance.capacityL = {
      method: "rules",
      evidence: c.evidence,
      confidence: c.confidence,
      ...(c.note ? { note: c.note } : {}),
    };
  }
  const w = weightAt(t);
  if (w) {
    fields.weightKg = w.value;
    provenance.weightKg = { method: "rules", evidence: w.evidence, confidence: w.confidence };
  }
  const wh = wheelsAt(t);
  if (wh) {
    fields.wheels = wh.value;
    provenance.wheels = { method: "rules", evidence: wh.evidence, confidence: 0.85 };
  }
  const ex = expandableAt(t);
  if (ex) {
    fields.expandable = true;
    provenance.expandable = { method: "rules", evidence: ex, confidence: 0.9 };
  }
  return { fields, provenance };
}

/* ── JSON-LD (v4 A4.1) ─────────────────────────────────────────────── */
/*  schema.org Product weight / depth / width / height (QuantitativeValue */
/*  with a unit) and additionalProperty (PropertyValue). A number without */
/*  a unit is skipped: nothing is guessed.                                */

const TO_CM: Record<string, number> = {
  cm: 1,
  cmt: 1,
  mm: 0.1,
  mmt: 0.1,
  in: 2.54,
  inh: 2.54,
  inch: 2.54,
  inches: 2.54,
};
const TO_KG: Record<string, number> = {
  kg: 1,
  kgm: 1,
  g: 0.001,
  grm: 0.001,
  lb: 0.45359237,
  lbs: 0.45359237,
  lbr: 0.45359237,
};
const TO_L: Record<string, number> = { l: 1, ltr: 1, litre: 1, liter: 1, litres: 1, liters: 1 };

type Quantity = { value: number; unit: string; text: string };

function quantityOf(v: unknown): Quantity | null {
  if (typeof v === "string") {
    const m = normalise(v).match(/^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z"]+)\.?\s*$/);
    if (!m) return null;
    return { value: Number(m[1]), unit: m[2].toLowerCase().replace('"', "in"), text: v.trim() };
  }
  if (!v || typeof v !== "object") return null;
  const q = v as Record<string, unknown>;
  const value =
    typeof q.value === "number"
      ? q.value
      : typeof q.value === "string"
        ? Number(normalise(q.value))
        : NaN;
  const unit = String(q.unitCode ?? q.unitText ?? "")
    .toLowerCase()
    .trim();
  if (!Number.isFinite(value) || value <= 0 || !unit) return null;
  return { value, unit, text: `${value} ${String(q.unitCode ?? q.unitText)}` };
}

const inUnit = (q: Quantity | null, table: Record<string, number>): number | null =>
  q && table[q.unit] ? round2(q.value * table[q.unit]) : null;

export function attributesFromJsonLd(node: Record<string, unknown>): AttributeResult | null {
  const fields: AttributeFields = {
    dimsCm: null,
    capacityL: null,
    weightKg: null,
    wheels: null,
    expandable: null,
  };
  const provenance: AttributeResult["provenance"] = {};
  const jsonld = (evidence: string): AttributeProvenance => ({
    method: "jsonld",
    evidence,
    confidence: 0.95,
  });

  const weight = quantityOf(node.weight);
  const kg = inUnit(weight, TO_KG);
  if (weight && kg) {
    fields.weightKg = kg;
    provenance.weightKg = jsonld(`weight: ${weight.text}`);
  }
  const [h, w, d] = (["height", "width", "depth"] as const).map((k) => quantityOf(node[k]));
  const dims = [h, w, d].map((q) => inUnit(q, TO_CM));
  if (dims.every((n): n is number => n !== null)) {
    fields.dimsCm = dims as [number, number, number];
    provenance.dimsCm = jsonld(`height: ${h!.text}, width: ${w!.text}, depth: ${d!.text}`);
  }

  const props = Array.isArray(node.additionalProperty) ? node.additionalProperty : [];
  for (const raw of props) {
    if (!raw || typeof raw !== "object") continue;
    const pv = raw as Record<string, unknown>;
    const name = typeof pv.name === "string" ? pv.name.trim() : "";
    if (!name) continue;
    const valueText =
      typeof pv.value === "number" || typeof pv.value === "string" ? String(pv.value).trim() : "";
    if (!valueText) continue;
    const unit =
      typeof pv.unitCode === "string"
        ? pv.unitCode
        : typeof pv.unitText === "string"
          ? pv.unitText
          : "";
    const stated = `${name}: ${valueText}${unit ? ` ${unit}` : ""}`;
    const q = quantityOf(unit ? { value: valueText, unitCode: unit } : valueText);
    if (/capacity|volume/i.test(name) && fields.capacityL === null) {
      const l = inUnit(q, TO_L);
      if (l) {
        fields.capacityL = l;
        provenance.capacityL = jsonld(stated);
      }
    } else if (/weight/i.test(name) && fields.weightKg === null) {
      const kgv = inUnit(q, TO_KG);
      if (kgv) {
        fields.weightKg = kgv;
        provenance.weightKg = jsonld(stated);
      }
    } else if (/dimension|size/i.test(name) && fields.dimsCm === null) {
      // "55 x 40 x 20 cm": the same rules as spec text, on the stated value only.
      const r = extractAttributes("", stated).fields.dimsCm;
      if (r) {
        fields.dimsCm = r;
        provenance.dimsCm = jsonld(stated);
      }
    } else if (/wheel/i.test(name) && fields.wheels === null) {
      const n = valueText.match(/^\s*([24])\b/)?.[1] ?? (/spinner/i.test(valueText) ? "4" : null);
      if (n) {
        fields.wheels = Number(n) as 2 | 4;
        provenance.wheels = jsonld(stated);
      }
    } else if (/expand/i.test(name) && /^(yes|true|oui)$/i.test(valueText)) {
      fields.expandable = true;
      provenance.expandable = jsonld(stated);
    }
  }
  return Object.keys(provenance).length ? { fields, provenance } : null;
}

/* ── Storage (catalog_variants.attributes) ─────────────────────────── */

/** One stored field: the value, how and where it was read, and when first. */
export type StoredAttribute = {
  value: unknown;
  method: AttributeProvenance["method"];
  evidence: string;
  confidence: number;
  sourceId: string;
  url: string;
  firstReadAt: string;
};

export function toStoredAttributes(
  r: AttributeResult,
  sourceId: string,
  url: string,
  readAt: string,
): Record<string, StoredAttribute> {
  const out: Record<string, StoredAttribute> = {};
  for (const k of Object.keys(r.fields) as (keyof AttributeFields)[]) {
    const p = r.provenance[k];
    if (r.fields[k] === null || !p) continue;
    out[k] = {
      value: r.fields[k],
      method: p.method,
      evidence: p.evidence,
      confidence: p.confidence,
      sourceId,
      url,
      firstReadAt: readAt,
    };
  }
  return out;
}

const METHOD_RANK: Record<string, number> = { jsonld: 3, rules: 2, ai: 1 };

/**
 * The incoming fields worth writing over what a variant has: a new field,
 * the same store stating it differently, or a better method (JSON-LD >
 * rules > AI) from another store. Otherwise the first value stays, so two
 * stores wording a spec differently don't flip it every run. null = nothing.
 */
export function mergeAttributes(
  existing: Record<string, unknown>,
  incoming: Record<string, StoredAttribute>,
): Record<string, StoredAttribute> | null {
  const out: Record<string, StoredAttribute> = {};
  for (const [k, next] of Object.entries(incoming)) {
    const prev = existing[k] as Partial<StoredAttribute> | undefined;
    if (!prev || typeof prev !== "object") {
      out[k] = next;
      continue;
    }
    const same =
      JSON.stringify(prev.value) === JSON.stringify(next.value) &&
      prev.evidence === next.evidence &&
      prev.method === next.method;
    if (same) continue;
    if (
      prev.sourceId === next.sourceId ||
      METHOD_RANK[next.method] > (METHOD_RANK[prev.method ?? ""] ?? 0)
    )
      out[k] = next;
  }
  return Object.keys(out).length ? out : null;
}
