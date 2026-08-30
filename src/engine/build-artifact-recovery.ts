import { createBuildCoordinator, type BuildCoordinator } from "./build-coordinator.ts";
import type { BuildTransport } from "./build-transport.ts";
import { resolveRegistryCredentialsForImage } from "./registry-config.ts";

export async function verifyArtifactRefs(args: {
  operationId: number;
  preferredWorkerId?: number | null;
  refs: Record<string, string>;
  transport: BuildTransport;
  coordinator?: BuildCoordinator;
}): Promise<number | null> {
  const images = Object.values(args.refs);
  if (!images.length) return null;
  if (images.some((image) => !/^.+@sha256:[0-9a-f]{64}$/.test(image))) return null;
  const coordinator = args.coordinator ?? createBuildCoordinator(args.transport);
  const verified = await coordinator.withWorker({
    operationId: args.operationId,
    preferredWorkerId: args.preferredWorkerId,
    run: async ({ server }) => {
      for (const image of images) {
        const credentials = await resolveRegistryCredentialsForImage(image);
        if (!await args.transport.verifyArtifact({
          server,
          image,
          registryUsername: credentials.username,
          registryPassword: credentials.password,
        })) return false;
      }
      return true;
    },
  });
  return verified.value ? verified.workerId : null;
}
