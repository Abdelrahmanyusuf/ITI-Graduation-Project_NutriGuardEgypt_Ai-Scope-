/**
 * Report writers: data-audit.json, data-audit.md, review queues.
 * All output is deterministic and written as UTF-8.
 */

import type {
  AuditReport,
  IngredientQueueRecord,
  RecipeClassRecord,
  SourceAudit,
} from "./types.js";

function fmtRate(rate: number | null): string {
  return rate === null ? "n/a" : rate.toFixed(4);
}

function pct(rate: number | null): string {
  return rate === null ? "n/a" : (rate * 100).toFixed(2) + "%";
}

function columnSummary(src: SourceAudit): string[] {
  if (src.columns.length === 0) return [];
  return src.columns.map(
    (c) =>
      `- \`${c.name}\`: present=${c.present} missing=${c.missing} distinct=${c.distinct} invalid_numeric=${c.invalidNumerics} zero=${c.zeroValues}` +
      (c.notes.length > 0 ? ` — ${c.notes.join("; ")}` : "")
  );
}

function ratioLine(label: string, r: SourceAudit["leadingQuantityHeuristic"]): string[] {
  if (r === null) return [`- ${label}: n/a`];
  return [
    `- ${label}: ${r.numerator}/${r.denominator} (${pct(r.rate)})`,
    `  - note: ${r.note}`,
  ];
}

function ratioLineUnknown(label: string, r: SourceAudit["canonicalQuantityParsingCoverage"]): string[] {
  if (r === null) return [`- ${label}: n/a`];
  const value = r.rate === null ? "unknown" : `${r.numerator}/${r.denominator} (${pct(r.rate)})`;
  return [
    `- ${label}: ${value}`,
    `  - note: ${r.note}`,
  ];
}

export function renderAuditMarkdown(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`# Data Audit Report`);
  lines.push(``);
  lines.push(`- Tool: ${report.tool}`);
  lines.push(`- Schema version: ${report.schemaVersion}`);
  lines.push(`- Raw root: ${report.rawRoot}`);
  lines.push(`- Structurally invalid inputs: **${report.structurallyInvalid ? "YES" : "no"}**`);
  lines.push(``);

  if (report.sourceManifest) {
    const m = report.sourceManifest;
    lines.push(`## Curated audit source manifest`);
    lines.push(``);
    lines.push(`- File: ${m.relativePath} (outside ${report.rawRoot}; raw inputs untouched)`);
    lines.push(`- sha256: ${m.sha256}`);
    for (const s of m.sources) {
      lines.push(
        `- \`${s.file}\`: source_id=${s.sourceId} name="${s.name}" title=${s.title ?? "n/a"} review_status=${s.reviewStatus}`
      );
    }
    lines.push(``);
    lines.push(`- The manifest records identity/title/date as an explicit provenance`);
    lines.push(`  record ONLY; license/approval review status remains pending (DATA_SOURCE_POLICY.md).`);
    lines.push(``);
  }

  for (const src of report.sources) {
    lines.push(`## ${src.relativePath}`);
    lines.push(``);
    lines.push(`- Kind: ${src.kind}`);
    lines.push(`- Format: ${src.format}`);
    lines.push(`- Encoding: ${src.encoding}`);
    lines.push(`- Bytes: ${src.bytes}`);
    lines.push(`- Document count: ${src.docCount}`);
    if (src.columnCount !== null) lines.push(`- Column count: ${src.columnCount}`);
    lines.push(``);

    if (src.columns.length > 0) {
      lines.push(`### Columns`);
      lines.push(``);
      lines.push(...columnSummary(src));
      lines.push(``);
    }

    if (src.duplicates.groups.length > 0) {
      lines.push(`### Duplicates`);
      lines.push(``);
      lines.push(`- Key: ${src.duplicates.byKey}`);
      lines.push(`- Duplicate groups: ${src.duplicates.groups.length}`);
      lines.push(`- Redundant rows: ${src.duplicates.duplicateRowCount}`);
      for (const g of src.duplicates.groups.slice(0, 20)) {
        lines.push(`  - \`${g.key}\` x${g.count}: rows ${g.rows.join(", ")}`);
      }
      lines.push(``);
    } else {
      lines.push(`- Duplicates: none found`);
      lines.push(``);
    }

    lines.push(`### Invalid numbers`);
    lines.push(``);
    lines.push(`- Count: ${src.invalidNumerics.count}`);
    for (const e of src.invalidNumerics.evidence) {
      lines.push(`  - row ${e.row} \`${e.column}\`: "${e.raw}"`);
    }
    lines.push(``);

    lines.push(`### Suspicious zeros`);
    lines.push(``);
    lines.push(`- Count: ${src.suspiciousZeros.count}`);
    for (const e of src.suspiciousZeros.evidence) {
      lines.push(`  - row ${e.row} \`${e.column}\`: "${e.raw}"${e.note ? " (" + e.note + ")" : ""}`);
    }
    lines.push(``);
    lines.push(`- Zero/missing conflation detected: ${src.zeroVsMissingConflation.detected ? "yes" : "no"}${src.zeroVsMissingConflation.columns.length > 0 ? " in [" + src.zeroVsMissingConflation.columns.join(", ") + "]" : ""}`);
    lines.push(``);

    lines.push(`### Coverage metrics`);
    lines.push(``);
    lines.push(`These are DIAGNOSTIC HEURISTICS, not canonical coverage. Canonical`);
    lines.push(`quantity parsing and ingredient-line mapping coverage remain unknown`);
    lines.push(`until approved rule sets exist.`);
    lines.push(``);
    lines.push(...ratioLine("leadingQuantityHeuristic", src.leadingQuantityHeuristic));
    lines.push(...ratioLine("recognizedUnitHeuristic", src.recognizedUnitHeuristic));
    lines.push(...ratioLineUnknown("canonicalQuantityParsingCoverage", src.canonicalQuantityParsingCoverage));
    lines.push(...ratioLineUnknown("canonicalIngredientLineMappingCoverage", src.canonicalIngredientLineMappingCoverage));
    lines.push(...ratioLine("Serving/yield coverage", src.servingYieldCoverage));
    lines.push(...ratioLine("Raw/cooked food-state coverage", src.foodStateCoverage));
    lines.push(``);

    lines.push(`### Ingredients`);
    lines.push(``);
    lines.push(`- Unique ingredient terms: ${src.uniqueIngredientTerms.count}`);
    if (src.uniqueIngredientTerms.topTerms.length > 0) {
      lines.push(`- Top terms: ${src.uniqueIngredientTerms.topTerms.join(", ")}`);
    }
    if (src.exactIngredientMatch) {
      const m = src.exactIngredientMatch;
      lines.push(`- Exact ingredient match: ${m.numerator}/${m.denominator} (${pct(m.rate)})`);
    }
    if (src.ambiguousMatches.length > 0) {
      lines.push(`- Ambiguous matches (samples):`);
      for (const a of src.ambiguousMatches.slice(0, 10)) {
        lines.push(`  - \`${a.term}\` -> [${a.candidates.join(", ")}]`);
      }
    }
    lines.push(``);

    lines.push(`### Egyptian-scope evidence`);
    lines.push(``);
    lines.push(`- Fields: ${src.egyptianScopeEvidence.fieldNames.join(", ") || "none"}`);
    lines.push(`- Note: ${src.egyptianScopeEvidence.note}`);
    lines.push(``);

    if (src.guidelineCoverage) {
      const g = src.guidelineCoverage;
      lines.push(`### Guideline source/date/provenance coverage`);
      lines.push(``);
      lines.push(`- Page count: ${g.pageCount ?? "not_assessed"}`);
      lines.push(`- Visible source: ${g.visibleSource ?? "not assessed"}`);
      lines.push(`- Visible title: ${g.visibleTitle ?? "not assessed"}`);
      lines.push(`- Visible date: ${g.visibleDate ?? "not assessed"}`);
      lines.push(`- Extraction available: ${g.extractionAvailable}`);
      lines.push(`- Provenance status: ${g.provenanceStatus}`);
      lines.push(`- OCR noise detected: ${g.ocrNoiseDetected ? "yes" : "no"}`);
      for (const n of g.notes) lines.push(`  - ${n}`);
      lines.push(``);
    }

    if (src.nutrition) {
      lines.push(`### Nutrition cell audit`);
      lines.push(``);
      lines.push(
        `- Columns: ${src.nutrition.columns.length} (missing | valid_numeric | explicit_zero | trace_marker | invalid)`
      );
      for (const c of src.nutrition.columns) {
        lines.push(
          `  - \`${c.column}\`: missing=${c.missing} valid=${c.validNumeric} zero=${c.explicitZero} trace=${c.recognizedTraceMarkers} invalid=${c.invalid}`
        );
        for (const e of c.evidence.slice(0, 6)) {
          lines.push(`      - row ${e.row} [${e.classification}]: "${e.raw}"${e.note ? " (" + e.note + ")" : ""}`);
        }
      }
      lines.push(``);
    }

    if (src.cuisineField || src.egyIngredientCoverageField) {
      lines.push(`### Field distributions (discriminative-scope analysis)`);
      lines.push(``);
      for (const f of [src.cuisineField, src.egyIngredientCoverageField]) {
        if (!f) continue;
        lines.push(`- \`${f.field}\`: distinct=${f.cardinality} present=${f.present} missing=${f.missing}`);
        lines.push(`  - ${f.constant ? "CONSTANT (non-discriminative): " : ""}${f.note}`);
      }
      lines.push(``);
    }

    lines.push(`### OCR / extraction noise`);
    lines.push(``);
    if (src.ocrOrExtractionNoise.detected) {
      lines.push(`- Detected: yes`);
      for (const k of src.ocrOrExtractionNoise.kinds) lines.push(`  - ${k}`);
      for (const s of src.ocrOrExtractionNoise.samples) lines.push(`  - ${s}`);
    } else {
      lines.push(`- Detected: no`);
    }
    lines.push(``);

    lines.push(`### Licensing`);
    lines.push(``);
    lines.push(`- License fields present: ${src.licensing.hasLicenseFields ? "yes" : "no"}`);
    if (src.licensing.candidateFields.length > 0) {
      lines.push(`- Candidate fields: ${src.licensing.candidateFields.join(", ")}`);
    }
    lines.push(`- Note: ${src.licensing.note}`);
    lines.push(``);

    lines.push(`### Encoding / mojibake`);
    lines.push(``);
    if (src.mojibake.detected) {
      lines.push(`- Mojibake detected: yes`);
      for (const k of src.mojibake.kinds) lines.push(`  - ${k}`);
      for (const e of src.mojibake.examples) lines.push(`  - e.g. ${e}`);
    } else {
      lines.push(`- Mojibake detected: no`);
    }
    for (const e of src.encodingIssues) lines.push(`- ${e}`);
    lines.push(``);

    if (src.structuralErrors.length > 0) {
      lines.push(`### Structural errors`);
      lines.push(``);
      for (const e of src.structuralErrors.slice(0, 50)) lines.push(`- ${e}`);
      lines.push(``);
    } else {
      lines.push(`- Structural errors: none`);
      lines.push(``);
    }
  }

  lines.push(`## Recipe classification (automated candidate/review only; never self-verified)`);
  lines.push(``);
  const c = report.recipeClassification.counts;
  lines.push(
    `- candidate=${c.candidate} needs_review=${c.needs_review} not_egyptian=${c.not_egyptian} rejected=${c.rejected}`
  );
  lines.push(
    `- Automated logic NEVER emits a verified status. Only a human reviewer may mark a recipe verified_egyptian (documented cultural evidence + reviewer identity/date required).`
  );
  lines.push(``);

  lines.push(`## Ingredient unique-normalized-term exact-vocabulary match`);
  lines.push(``);
  lines.push(`- Claimed baseline (Step 2 spec): ${report.ingredientMatching.claimedBaseline}`);
  lines.push(
    `- Unique-normalized-term exact-vocabulary match: ${report.ingredientMatching.recalculated.numerator}/${report.ingredientMatching.recalculated.denominator} (${pct(report.ingredientMatching.recalculated.rate)})`
  );
  lines.push(
    `- This measures exact equality of unique normalized terms against the reference FOOD vocabulary. It is NOT canonical ingredient-line mapping coverage and NOT quantity-parsing coverage (both remain unknown until approved rule sets exist).`
  );
  lines.push(`- Unique normalized terms: ${report.ingredientMatching.uniqueTerms}`);
  lines.push(``);

  lines.push(`## Structural errors`);
  lines.push(``);
  if (report.structuralErrors.length > 0) {
    lines.push(`- Total: ${report.structuralErrors.length}`);
    for (const e of report.structuralErrors) lines.push(`  - ${e}`);
  } else {
    lines.push(`- None across all sources (all required inputs present and structurally valid).`);
  }
  lines.push(``);

  lines.push(`## Raw input provenance (SHA-256)`);
  lines.push(``);
  for (const f of report.rawProvenance.files) {
    lines.push(`- ${f.relativePath}: sha256=${f.sha256} bytes=${f.byteSize}`);
  }
  lines.push(``);
  lines.push(`> This is a deterministic, read-only audit. Raw files under ${report.rawRoot} were not modified.`);

  return lines.join("\n");
}

export function renderQueueMarkdown(
  kind: "recipe" | "ingredient",
  records: RecipeClassRecord[] | IngredientQueueRecord[],
  source: string
): string {
  const lines: string[] = [];
  lines.push(`# ${kind === "recipe" ? "Recipe" : "Ingredient"} Review Queue`);
  lines.push(``);
  lines.push(`- Source: ${source}`);
  lines.push(`- Records: ${records.length}`);
  lines.push(``);
  if (kind === "recipe") {
    const recs = records as RecipeClassRecord[];
    for (const r of recs) {
      lines.push(`- row ${r.row} [${r.classification}] ${r.title}`);
      for (const reason of r.reasons) lines.push(`  - ${reason}`);
      for (const s of r.signals) lines.push(`  - signal: ${s}`);
      for (const t of r.broadTags) lines.push(`  - broad tag (discounted, NOT positive evidence): ${t}`);
      lines.push(
        `  - human verification: ${r.humanVerification.status}${r.humanVerification.reviewerId ? ` (reviewer ${r.humanVerification.reviewerId})` : ""}`
      );
    }
  } else {
    const recs = records as IngredientQueueRecord[];
    for (const r of recs) {
      lines.push(`- row ${r.row} ${r.matched ? "[matched]" : "[unmatched]"} ${r.term}`);
      lines.push(`  - ${r.reason}`);
    }
  }
  lines.push(``);
  return lines.join("\n");
}

/** Deterministic JSON stringification with sorted keys. */
export function stableJson(data: unknown): string {
  const sortValue = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortValue);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        out[key] = sortValue((v as Record<string, unknown>)[key]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sortValue(data), null, 2) + "\n";
}

export { fmtRate };