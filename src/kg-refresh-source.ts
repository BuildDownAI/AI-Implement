/** Refresh identity resolved once at orchestrator boot. Base code comes from the runner image. */
export interface KgBaseSettings {
  kgCodeRepo?: string | null;
  kgNamespace?: string | null;
  kgGraphName?: string | null;
  kgGraphLabel?: string | null;
  kgStardogDb?: string | null;
}
export type KgRefreshSource =
  | { mode: "customer"; runRepo: string }
  | ({ mode: "base"; runRepo: string } & Required<{ [K in keyof KgBaseSettings]: string }>)
  | { mode: "unavailable"; reason: string };

export function resolveKgRefreshSource(kgSourceRepo: string | null | undefined, base: KgBaseSettings): KgRefreshSource {
  if (kgSourceRepo?.trim()) return { mode: "customer", runRepo: kgSourceRepo.trim() };
  const names = { kgCodeRepo: "kg_code_repo", kgNamespace: "kg_namespace", kgGraphName: "kg_graph_name", kgGraphLabel: "kg_graph_label", kgStardogDb: "kg_stardog_db" } as const;
  const missing = (Object.keys(names) as Array<keyof typeof names>).filter(k => !base[k]?.trim());
  if (missing.length) return { mode: "unavailable", reason: `KG_SOURCE_REPO is unset; missing base-mode values: ${missing.map(k => names[k]).join(", ")}` };
  const values = Object.fromEntries(Object.keys(names).map(k => [k, base[k as keyof KgBaseSettings]!.trim()])) as Required<{ [K in keyof KgBaseSettings]: string }>;
  return { mode: "base", runRepo: values.kgCodeRepo, ...values };
}

let bootSource: KgRefreshSource | undefined;
export function setBootKgRefreshSource(source: KgRefreshSource): void { bootSource = source; }
export function getBootKgRefreshSource(): KgRefreshSource | undefined { return bootSource; }
export function kgRefreshRunRepo(customerRepo?: string | null): string | null {
  return bootSource ? (bootSource.mode === "unavailable" ? null : bootSource.runRepo) : customerRepo ?? null;
}
