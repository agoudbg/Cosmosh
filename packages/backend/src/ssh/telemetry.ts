/** Parsed system metrics collected from one remote SSH telemetry probe. */
export type ParsedRemoteTelemetry = {
  cpuUsagePercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  networkRxBytesTotal: number;
  networkTxBytesTotal: number;
};

/**
 * Collects remote CPU, memory, and network counters as three machine-readable lines.
 *
 * The probe is wrapped in sh -lc because SSH exec requests may start under an
 * arbitrary login shell. The awk programs are inside shell double quotes, so
 * every awk field reference must escape $ before the command reaches the remote
 * shell. Without those escapes, the shell removes the awk expressions and the
 * CPU fallback silently emits its cpu default.
 */
export const TELEMETRY_COMMAND =
  ' sh -lc \'cpu=$(top -bn1 | awk -F"[, ]+" "/Cpu\\(s\\)|%Cpu\\(s\\)/ {for(i=1;i<=NF;i++){if(\\$i==\\"id\\"){print 100-\\$(i-1); exit}}}"); if [ -z "$cpu" ]; then cpu=$(awk "/^cpu /{idle=\\$5;total=0;for(i=2;i<=NF;i++){total+=\\$i} if(total>0){print (total-idle)*100/total}else{print 0}}" /proc/stat); fi; mem=$(free -b | awk "/^Mem:/ {print \\$3 \\" \\" \\$2}"); net=$(awk "NR>2 {rx+=\\$2;tx+=\\$10} END {print rx \\" \\" tx}" /proc/net/dev); printf "%s\\n%s\\n%s\\n" "${cpu:-0}" "${mem:-0 0}" "${net:-0 0}"\'';

/**
 * Parses the fixed three-line output produced by the remote telemetry probe.
 *
 * @param output Raw stdout returned by the SSH exec channel.
 * @returns Normalized telemetry values, or null when any required value is invalid.
 */
export const parseTelemetryOutput = (output: string): ParsedRemoteTelemetry | null => {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 3) {
    return null;
  }

  const cpuUsagePercent = Number.parseFloat(lines[0] ?? '0');
  const [memoryUsedRaw, memoryTotalRaw] = (lines[1] ?? '').split(/\s+/);
  const [networkRxRaw, networkTxRaw] = (lines[2] ?? '').split(/\s+/);

  const memoryUsedBytes = Number.parseInt(memoryUsedRaw ?? '0', 10);
  const memoryTotalBytes = Number.parseInt(memoryTotalRaw ?? '0', 10);
  const networkRxBytesTotal = Number.parseInt(networkRxRaw ?? '0', 10);
  const networkTxBytesTotal = Number.parseInt(networkTxRaw ?? '0', 10);

  if (
    !Number.isFinite(cpuUsagePercent) ||
    !Number.isFinite(memoryUsedBytes) ||
    !Number.isFinite(memoryTotalBytes) ||
    !Number.isFinite(networkRxBytesTotal) ||
    !Number.isFinite(networkTxBytesTotal)
  ) {
    return null;
  }

  return {
    cpuUsagePercent: Math.max(0, Math.min(100, cpuUsagePercent)),
    memoryUsedBytes: Math.max(0, memoryUsedBytes),
    memoryTotalBytes: Math.max(0, memoryTotalBytes),
    networkRxBytesTotal: Math.max(0, networkRxBytesTotal),
    networkTxBytesTotal: Math.max(0, networkTxBytesTotal),
  };
};
