import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { getDevBrowserBaseDir } from "./local-endpoint.js";

const BASELINES_DIR = path.join(getDevBrowserBaseDir(), "baselines");
const DIFFS_DIR = path.join(getDevBrowserBaseDir(), "diffs");

const SAFE_NAME_PATTERN = /[^A-Za-z0-9._-]/g;

export interface CompareOptions {
  threshold?: number;
  colorThreshold?: number;
  ignoreAntialiasing?: boolean;
}

export interface CompareResult {
  match: boolean;
  diffPercentage: number;
  diffPixelCount: number;
  diffImagePath: string;
  currentImagePath: string;
  baselineImagePath: string;
  summary: string;
}

export interface BaselineInfo {
  name: string;
  path: string;
  createdAt: string;
  dimensions: { width: number; height: number };
}

function sanitizeName(name: unknown): string {
  const str = String(name);
  if (str.length === 0) throw new Error("Baseline name must not be empty");
  const safe = str.replace(SAFE_NAME_PATTERN, "_");
  if (safe.length === 0 || safe === "." || safe === "..") {
    throw new Error(`Invalid baseline name: ${str}`);
  }
  return safe;
}

function decodePng(buffer: Buffer): PNG {
  return PNG.sync.read(buffer);
}

async function ensureDirs(): Promise<void> {
  await mkdir(BASELINES_DIR, { recursive: true });
  await mkdir(DIFFS_DIR, { recursive: true });
}

function decodePayload(payload: unknown): Buffer {
  if (typeof payload !== "object" || payload === null) {
    throw new TypeError("Image payload must be an object with encoding and data fields");
  }
  const { encoding, data } = payload as { encoding?: unknown; data?: unknown };
  if (typeof data !== "string") {
    throw new TypeError("Image payload data must be a string");
  }
  if (encoding === "base64") {
    return Buffer.from(data, "base64");
  }
  if (encoding === "utf8") {
    return Buffer.from(data, "utf8");
  }
  throw new TypeError(`Unsupported image payload encoding: ${encoding}`);
}

export async function saveBaseline(
  name: unknown,
  imagePayload: unknown,
): Promise<string> {
  await ensureDirs();
  const safeName = sanitizeName(name);
  const baselinePath = path.join(BASELINES_DIR, `${safeName}.png`);
  const imageBuffer = decodePayload(imagePayload);
  await writeFile(baselinePath, imageBuffer);
  return baselinePath;
}

export async function compareWithBaseline(
  name: unknown,
  imagePayload: unknown,
  options: unknown,
): Promise<CompareResult> {
  await ensureDirs();
  const safeName = sanitizeName(name);
  const opts = (options ?? {}) as CompareOptions;

  const baselinePath = path.join(BASELINES_DIR, `${safeName}.png`);
  const currentPath = path.join(DIFFS_DIR, `${safeName}-current.png`);
  const diffPath = path.join(DIFFS_DIR, `${safeName}-diff.png`);

  let baselineBuffer: Buffer;
  try {
    baselineBuffer = await readFile(baselinePath);
  } catch {
    throw new Error(
      `No baseline found for "${safeName}". Run screenshot.baseline(page, "${safeName}") first.`,
    );
  }

  const currentBuffer = decodePayload(imagePayload);
  await writeFile(currentPath, currentBuffer);

  const baseline = decodePng(baselineBuffer);
  const current = decodePng(currentBuffer);

  if (baseline.width !== current.width || baseline.height !== current.height) {
    return {
      match: false,
      diffPercentage: 100,
      diffPixelCount: -1,
      diffImagePath: diffPath,
      currentImagePath: currentPath,
      baselineImagePath: baselinePath,
      summary: `Dimension mismatch: baseline is ${baseline.width}x${baseline.height}, current is ${current.width}x${current.height}`,
    };
  }

  const { width, height } = baseline;
  const totalPixels = width * height;
  const diffPng = new PNG({ width, height });

  const threshold = typeof opts.threshold === "number" ? opts.threshold : 0.1;
  const includeAA = opts.ignoreAntialiasing !== false;

  const diffPixelCount = pixelmatch(
    baseline.data,
    current.data,
    diffPng.data,
    width,
    height,
    {
      threshold,
      includeAA: !includeAA,
    },
  );

  const diffBuffer = PNG.sync.write(diffPng);
  await writeFile(diffPath, diffBuffer);

  const diffPercentage = totalPixels > 0 ? (diffPixelCount / totalPixels) * 100 : 0;
  const match = diffPixelCount === 0;

  const summary = match
    ? `No visual differences detected (100% match).`
    : `Visual regression detected: ${diffPercentage.toFixed(2)}% of pixels differ (${diffPixelCount} pixels). Diff image: ${diffPath}`;

  return {
    match,
    diffPercentage,
    diffPixelCount,
    diffImagePath: diffPath,
    currentImagePath: currentPath,
    baselineImagePath: baselinePath,
    summary,
  };
}

export async function listBaselines(): Promise<BaselineInfo[]> {
  try {
    await mkdir(BASELINES_DIR, { recursive: true });
    const { readdir, stat } = await import("node:fs/promises");
    const files = await readdir(BASELINES_DIR);
    const baselines: BaselineInfo[] = [];

    for (const file of files) {
      if (!file.endsWith(".png")) continue;
      const filePath = path.join(BASELINES_DIR, file);
      const name = file.slice(0, -4);
      let dimensions = { width: 0, height: 0 };
      let createdAt = "";

      try {
        const stats = await stat(filePath);
        createdAt = stats.birthtime.toISOString();
        const buffer = await readFile(filePath);
        const png = decodePng(buffer);
        dimensions = { width: png.width, height: png.height };
      } catch {
        // Skip unreadable files
        continue;
      }

      baselines.push({ name, path: filePath, createdAt, dimensions });
    }

    return baselines;
  } catch {
    return [];
  }
}
