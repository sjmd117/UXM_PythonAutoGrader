import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

export type SubmissionMeta = {
  id: string;
  filename: string;
  extension: ".py" | ".ipynb";
  uploadedAt: string;
  size: number;
};

export type SubmissionDetail = SubmissionMeta & {
  code: string;
};

export type SubmissionSource = SubmissionMeta & {
  content: string;
};

type SubmissionIndex = {
  items: SubmissionMeta[];
};

const DATA_ROOT = path.join(process.cwd(), "data", "submissions");
const INDEX_PATH = path.join(DATA_ROOT, "index.json");
const MAX_FILE_SIZE = 2 * 1024 * 1024;

function extOf(name: string): ".py" | ".ipynb" | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".py")) {
    return ".py";
  }
  if (lower.endsWith(".ipynb")) {
    return ".ipynb";
  }
  return null;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "_").trim() || "submission.py";
}

function splitNameAndExt(filename: string): { name: string; ext: string } {
  const ext = path.extname(filename);
  const name = filename.slice(0, Math.max(0, filename.length - ext.length));
  return { name, ext };
}

function dedupeFilename(filename: string, existing: SubmissionMeta[]): string {
  const existingLower = new Set(existing.map((item) => item.filename.toLowerCase()));
  if (!existingLower.has(filename.toLowerCase())) {
    return filename;
  }

  const { name, ext } = splitNameAndExt(filename);
  let seq = 2;
  while (true) {
    const candidate = `${name} (${seq})${ext}`;
    if (!existingLower.has(candidate.toLowerCase())) {
      return candidate;
    }
    seq += 1;
  }
}

function decodeUtf16Be(buffer: Buffer): string {
  const size = buffer.length - (buffer.length % 2);
  const swapped = Buffer.alloc(size);
  for (let i = 0; i < size; i += 2) {
    swapped[i] = buffer[i + 1];
    swapped[i + 1] = buffer[i];
  }
  return swapped.toString("utf16le");
}

function decodeTextWithFallback(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.toString("utf8");
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return decodeUtf16Be(buffer.subarray(2));
  }

  const utf8 = buffer.toString("utf8");
  const utf16le = buffer.toString("utf16le");
  const utf16be = decodeUtf16Be(buffer);
  const candidates = [utf8, utf16le, utf16be];
  const ranked = candidates.sort((a, b) => b.replace(/\u0000/g, "").length - a.replace(/\u0000/g, "").length);
  return ranked[0];
}

function parseNotebookJson(buffer: Buffer): unknown {
  const candidates = [decodeTextWithFallback(buffer), buffer.toString("utf8"), buffer.toString("utf16le"), decodeUtf16Be(buffer)];

  const uniqueCandidates = [...new Set(candidates)];
  for (const text of uniqueCandidates) {
    const cleaned = text.replace(/^\uFEFF/, "").trim();
    if (!cleaned) {
      continue;
    }

    try {
      return JSON.parse(cleaned);
    } catch {
      continue;
    }
  }

  throw new Error("ipynb JSON 파싱에 실패했습니다. 파일 인코딩 또는 형식을 확인해주세요.");
}

function notebookToPython(notebookBuffer: Buffer): string {
  const parsed = parseNotebookJson(notebookBuffer);

  if (!parsed || typeof parsed !== "object" || !("cells" in parsed)) {
    throw new Error("유효한 ipynb 파일이 아닙니다.");
  }

  const cells = (parsed as { cells?: unknown }).cells;
  if (!Array.isArray(cells)) {
    throw new Error("ipynb cells 구조가 올바르지 않습니다.");
  }

  const codeChunks: string[] = [];
  for (const cell of cells) {
    if (!cell || typeof cell !== "object") {
      continue;
    }

    const cellType = (cell as { cell_type?: unknown }).cell_type;
    if (cellType !== "code") {
      continue;
    }

    const source = (cell as { source?: unknown }).source;
    if (Array.isArray(source)) {
      const lines = source.map((line) => (typeof line === "string" ? line : "")).join("");
      codeChunks.push(lines);
      continue;
    }
    if (typeof source === "string") {
      codeChunks.push(source);
    }
  }

  const merged = codeChunks.join("\n\n").trim();
  if (!merged) {
    throw new Error("ipynb 안에 실행 가능한 code cell이 없습니다.");
  }
  return merged;
}

async function ensureStore() {
  await fs.mkdir(DATA_ROOT, { recursive: true });
  try {
    await fs.access(INDEX_PATH);
  } catch {
    const initial: SubmissionIndex = { items: [] };
    await fs.writeFile(INDEX_PATH, JSON.stringify(initial, null, 2), "utf8");
  }
}

async function readIndex(): Promise<SubmissionIndex> {
  await ensureStore();
  const raw = await fs.readFile(INDEX_PATH, "utf8");
  const parsed = JSON.parse(raw) as SubmissionIndex;
  return {
    items: Array.isArray(parsed.items) ? parsed.items : [],
  };
}

async function writeIndex(index: SubmissionIndex) {
  await fs.writeFile(INDEX_PATH, JSON.stringify(index, null, 2), "utf8");
}

export async function listSubmissions(): Promise<SubmissionMeta[]> {
  const index = await readIndex();
  return [...index.items].sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
}

export async function createSubmissionFromFile(file: File): Promise<SubmissionMeta> {
  const rawName = sanitizeFilename(file.name);
  const extension = extOf(rawName);

  if (!extension) {
    throw new Error(".py 또는 .ipynb 파일만 업로드할 수 있습니다.");
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new Error("파일 크기는 최대 2MB까지 허용됩니다.");
  }

  const arrayBuffer = await file.arrayBuffer();
  const rawBuffer = Buffer.from(arrayBuffer);
  const content = decodeTextWithFallback(rawBuffer);
  const code = extension === ".ipynb" ? notebookToPython(rawBuffer) : content;

  if (!code.trim()) {
    throw new Error("빈 코드 파일은 업로드할 수 없습니다.");
  }

  const id = crypto.randomUUID();
  const uploadedAt = new Date().toISOString();

  await ensureStore();
  const index = await readIndex();
  const filename = dedupeFilename(rawName, index.items);

  const sourcePath = path.join(DATA_ROOT, `${id}${extension}`);
  const codePath = path.join(DATA_ROOT, `${id}.code.py`);
  await fs.writeFile(sourcePath, content, "utf8");
  await fs.writeFile(codePath, code, "utf8");

  const item: SubmissionMeta = {
    id,
    filename,
    extension,
    uploadedAt,
    size: file.size,
  };

  index.items.push(item);
  await writeIndex(index);
  return item;
}

export async function getSubmissionById(id: string): Promise<SubmissionDetail | null> {
  const index = await readIndex();
  const item = index.items.find((entry) => entry.id === id);
  if (!item) {
    return null;
  }

  const codePath = path.join(DATA_ROOT, `${item.id}.code.py`);
  try {
    const code = await fs.readFile(codePath, "utf8");
    return { ...item, code };
  } catch {
    return null;
  }
}

export async function listSubmissionDetails(): Promise<SubmissionDetail[]> {
  const index = await readIndex();
  const sorted = [...index.items].sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
  const details = await Promise.all(
    sorted.map(async (item) => {
      const codePath = path.join(DATA_ROOT, `${item.id}.code.py`);
      try {
        const code = await fs.readFile(codePath, "utf8");
        return { ...item, code };
      } catch {
        return null;
      }
    }),
  );

  return details.filter((item): item is SubmissionDetail => item !== null);
}

export async function getSubmissionSourceById(id: string): Promise<SubmissionSource | null> {
  const index = await readIndex();
  const item = index.items.find((entry) => entry.id === id);
  if (!item) {
    return null;
  }

  const sourcePath = path.join(DATA_ROOT, `${item.id}${item.extension}`);
  try {
    const content = await fs.readFile(sourcePath, "utf8");
    return { ...item, content };
  } catch {
    return null;
  }
}

export async function deleteSubmissionsByIds(ids: string[]): Promise<{ deletedCount: number }> {
  if (ids.length === 0) {
    return { deletedCount: 0 };
  }

  const idSet = new Set(ids);
  const index = await readIndex();
  const targets = index.items.filter((item) => idSet.has(item.id));

  await Promise.all(
    targets.map(async (item) => {
      const sourcePath = path.join(DATA_ROOT, `${item.id}${item.extension}`);
      const codePath = path.join(DATA_ROOT, `${item.id}.code.py`);
      await fs.rm(sourcePath, { force: true });
      await fs.rm(codePath, { force: true });
    }),
  );

  index.items = index.items.filter((item) => !idSet.has(item.id));
  await writeIndex(index);
  return { deletedCount: targets.length };
}
