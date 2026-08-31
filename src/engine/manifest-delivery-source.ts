import * as db from "../shared/db.ts";
import { secretStore } from "../shared/secret-store.ts";

/** Commit the non-artifact part of an image-backed manifest only after its
 * configuration/rollout succeeds. Build-backed manifests are attached by the
 * build-delivery parent after the immutable artifact is deployed. */
export async function commitManifestDeliverySource(
  appId: number,
  source: "build" | "image" | undefined,
): Promise<void> {
  if (source !== "image") return;
  const removedSourceId = db.clearAppBuildConfig(appId);
  if (removedSourceId != null) {
    await secretStore.delete(`build_source_webhook:${removedSourceId}`);
  }
}
