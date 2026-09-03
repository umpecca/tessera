const fileSizeUnits = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

export function formatFileSize(size, kind = "file") {
  if (kind === "directory") {
    return "";
  }
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
    return "—";
  }

  const bytes = Math.floor(size);
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    fileSizeUnits.length - 1,
  );
  const value = bytes / (1024 ** unitIndex);
  const digits = value < 10 ? 1 : 0;
  return `${value.toFixed(digits).replace(/\.0$/, "")} ${fileSizeUnits[unitIndex]}`;
}
