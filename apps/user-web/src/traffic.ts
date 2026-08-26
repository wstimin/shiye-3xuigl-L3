const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * 1024;
const BYTES_PER_GB = BYTES_PER_MB * 1024;

export function trafficBytes(value: number | string | undefined, fallbackGb: number | string | undefined = 0) {
  const bytes = Number(value);
  if (Number.isFinite(bytes) && bytes >= 0) return bytes;
  const gb = Number(fallbackGb);
  return Number.isFinite(gb) && gb > 0 ? gb * BYTES_PER_GB : 0;
}

export function formatTraffic(value: number | string | undefined, fallbackGb: number | string | undefined = 0) {
  const bytes = trafficBytes(value, fallbackGb);
  if (bytes >= BYTES_PER_GB) return `${format(bytes / BYTES_PER_GB)} GB`;
  if (bytes >= BYTES_PER_MB) return `${format(bytes / BYTES_PER_MB)} MB`;
  if (bytes >= BYTES_PER_KB) return `${format(bytes / BYTES_PER_KB)} KB`;
  return `${Math.round(bytes)} B`;
}

function format(value: number) {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
