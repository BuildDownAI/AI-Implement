import { createHash } from "node:crypto";

// Match the JSON sent over ingress: omit undefined object fields and preserve array order.
export function ownedRunReportFingerprint(value: unknown): string {
  function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
      const object = value as Record<string, unknown>;
      return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }
  return createHash("sha256").update(canonical(JSON.parse(JSON.stringify(value)))).digest("hex");
}
