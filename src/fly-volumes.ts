import { FLY_API_BASE, flyHeaders } from "./fly-machines.js";

export interface FlyVolume {
  id: string;
  name: string;
  snapshot_retention?: number;
}

export async function listVolumes(token: string, appName: string): Promise<FlyVolume[]> {
  const res = await fetch(`${FLY_API_BASE}/apps/${appName}/volumes`, { headers: flyHeaders(token) });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} listing volumes in ${appName}: ${body}`);
  }

  return (await res.json()) as FlyVolume[];
}

export async function setVolumeSnapshotRetention(
  token: string,
  appName: string,
  volumeId: string,
  days: number,
): Promise<void> {
  const res = await fetch(`${FLY_API_BASE}/apps/${appName}/volumes/${volumeId}`, {
    method: "PUT",
    headers: flyHeaders(token),
    body: JSON.stringify({ snapshot_retention: days }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} updating volume ${volumeId} in ${appName}: ${body}`);
  }
}

/**
 * Applies `days` to every volume of the app whose snapshot retention differs.
 * Never throws: a Fly error comes back as `skipped`, and volumes already
 * changed stay in `applied`. `skipped` is empty on full success.
 */
export async function applyVolumeSnapshotRetention(
  token: string,
  appName: string,
  days: number,
): Promise<{ applied: string[]; skipped: string }> {
  const applied: string[] = [];
  try {
    const volumes = await listVolumes(token, appName);
    for (const volume of volumes) {
      if (volume.snapshot_retention === days) continue;
      await setVolumeSnapshotRetention(token, appName, volume.id, days);
      applied.push(volume.id);
    }
    return { applied, skipped: "" };
  } catch (err) {
    return { applied, skipped: err instanceof Error ? err.message : String(err) };
  }
}

/** Boot step: applies the retention setting to the orchestrator's own volumes and logs the outcome. */
export async function applyVolumeSnapshotRetentionAtBoot(
  flyDeployToken: string | null | undefined,
  appName: string | undefined,
  getDays: () => number,
): Promise<void> {
  if (!flyDeployToken || !appName) {
    const reason = !flyDeployToken ? "FLY_DEPLOY_TOKEN is not set" : "FLY_APP_NAME is not set";
    console.log(`[fly-volumes] snapshot retention not applied: ${reason}`);
    return;
  }
  try {
    const days = getDays();
    const { applied, skipped } = await applyVolumeSnapshotRetention(flyDeployToken, appName, days);
    if (applied.length > 0) {
      console.log(`[fly-volumes] snapshot retention ${days} days applied to ${applied.join(", ")}`);
    }
    if (skipped) {
      console.log(`[fly-volumes] snapshot retention not applied: ${skipped}`);
    } else if (applied.length === 0) {
      console.log(`[fly-volumes] snapshot retention ${days} days already set on every volume`);
    }
  } catch (err) {
    console.log(`[fly-volumes] snapshot retention not applied: ${err instanceof Error ? err.message : String(err)}`);
  }
}
