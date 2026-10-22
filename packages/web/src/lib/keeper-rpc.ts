export function resolveKeeperRpcUrls(readRpcUrl: string, writeRpcUrl?: string) {
  return {
    readRpcUrl,
    writeRpcUrl: writeRpcUrl?.trim() || readRpcUrl,
  };
}
