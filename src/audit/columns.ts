/**
 * Per-column audit aggregation. Deterministic.
 */

import { isNumeric } from "./numbers.js";
import type { ColumnAudit } from "./types.js";

function classifyCell(v: string): string {
  if (/^(true|false|TRUE|FALSE)$/.test(v)) return "boolean";
  if (isNumeric(v)) return "number";
  if (v.startsWith("[")) return "list";
  if (/^(null|NULL|Na\/?N|n\/?a|N\/A|""|unknown|Unknown|-)$/.test(v)) return "missing_marker";
  return "string";
}

export class ColumnAnalyzer {
  private readonly cells: string[][] = [];

  constructor(private readonly headers: string[]) {
    this.cells = headers.map(() => []);
  }

  /** Record one row's field values; missing trailing cells are left empty. */
  add(rowValues: readonly string[]): void {
    for (let i = 0; i < this.headers.length; i += 1) {
      const v = (rowValues[i] ?? "").trim();
      this.cells[i].push(v);
    }
  }

  /**
   * Which columns should be treated as numeric for zero/coercion analysis?
   * A column is numeric when name-matched against a known numeric column, or
   * when a clear majority of its non-empty cells are numbers (>= 0.86).
   */
  numericColumnKeys(headers: ReadonlySet<string>): Set<string> {
    const normalizeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const namedKeys = new Set<string>([...headers].map(normalizeName));
    const named = new Set<string>();
    for (let idx = 0; idx < this.headers.length; idx += 1) {
      const name = this.headers[idx];
      if (namedKeys.has(normalizeName(name)) || this.isMostlyNumeric(this.cells[idx])) {
        named.add(name);
      }
    }
    return named;
  }

  private isMostlyNumeric(cells: string[]): boolean {
    let present = 0;
    let numeric = 0;
    for (const c of cells) {
      const t = c.trim();
      if (t === "") continue;
      present += 1;
      if (isNumeric(t)) numeric += 1;
    }
    return present > 0 && numeric / present >= 0.86;
  }

  finish(numericColumns: ReadonlySet<string>): ColumnAudit[] {
    const effective = this.numericColumnKeys(numericColumns);
    return this.headers.map((name, idx) => {
      const cells = this.cells[idx];
      let present = 0;
      let missing = 0;
      const distinct = new Set<string>();
      const inferredTypes: Record<string, number> = {};
      for (const c of cells) {
        if (c === "") {
          missing += 1;
          continue;
        }
        present += 1;
        distinct.add(c);
        const type = classifyCell(c);
        inferredTypes[type] = (inferredTypes[type] ?? 0) + 1;
      }

      const audit: ColumnAudit = {
        name,
        present,
        missing,
        distinct: distinct.size,
        inferredTypes,
        invalidNumerics: 0,
        zeroValues: 0,
        notes: [],
      };

      if (effective.has(name)) {
        let zeros = 0;
        let nonNumeric = 0;
        for (const c of cells) {
          if (c === "") continue;
          if (isNumeric(c)) {
            if (/^[+-]?0+(?:\.0+)?$/.test(c)) zeros += 1;
          } else {
            nonNumeric += 1;
          }
        }
        audit.zeroValues = zeros;
        audit.invalidNumerics = nonNumeric;
        if (missing > 0 && zeros > 0) {
          audit.notes.push(
            "mixes empty cells and explicit zeros (possible missing->0 conflation; needs manual check)"
          );
        }
      }
      return audit;
    });
  }
}