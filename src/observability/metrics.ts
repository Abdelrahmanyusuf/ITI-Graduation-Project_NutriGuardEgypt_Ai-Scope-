const METRIC_NAME = /^[a-z][a-z0-9_]*$/;
export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  public increment(name: string, labels: Record<string, string> = {}, amount = 1): void {
    if (!METRIC_NAME.test(name) || !Number.isFinite(amount) || amount < 0) throw new Error("invalid metric");
    const safe = Object.entries(labels).sort().map(([key, value]) => {
      if (!/^(route|method|status|outcome|dependency)$/.test(key) || value.length > 40) throw new Error("metric labels must be bounded and non-sensitive");
      return `${key}="${value.replace(/[\\"\n]/g, "_")}"`;
    }).join(",");
    const key = `${name}|${safe}`; this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
  }
  public render(): string { return [...this.counters.entries()].sort().map(([key, value]) => { const [name, labels] = key.split("|"); return `${name}${labels ? `{${labels}}` : ""} ${value}`; }).join("\n") + "\n"; }
}
