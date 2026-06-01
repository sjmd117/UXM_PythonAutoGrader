import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { unzipSync } from "fflate";
import { repairFilenameMojibake } from "@/lib/repair-filename";

export type SubmissionMeta = {
  id: string;
  filename: string;
  extension: ".py" | ".ipynb";
  size: number;
  studentId?: string;
  studentName?: string;
  identitySource?: "zip" | "filename";
  zipOwnerName?: string;
};

export type NotebookCodeCell = {
  id: string;
  index: number;
  source: string;
};

export type SubmissionDetail = SubmissionMeta & {
  code: string;
  notebookCells?: NotebookCodeCell[];
};

export type SubmissionSource = SubmissionMeta & {
  content: string;
};

export type SkippedSubmission = {
  filename: string;
  reason: string;
};

export type SubmissionUploadResult = {
  created: SubmissionMeta[];
  skipped: SkippedSubmission[];
};

type SubmissionIndex = {
  items: SubmissionMeta[];
};

type StudentIdentity = {
  studentId: string;
  studentName: string;
  identitySource: "zip" | "filename";
};

const LEGACY_DATA_ROOT = path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "submissions");
const PROJECTS_ROOT = path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "projects");
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const MAX_ZIP_FILE_SIZE = 50 * 1024 * 1024;
const MAX_ZIP_ENTRY_SIZE = 2 * 1024 * 1024;
const MAX_ZIP_SUBMISSIONS = 500;
const EMPTY_NOTEBOOK_MESSAGE = "ipynb 안에 실행 가능한 code cell이 없습니다.";

function assertProjectId(projectId: string) {
  if (!/^[a-zA-Z0-9_-]+$/u.test(projectId)) {
    throw new Error("유효하지 않은 과제 ID입니다.");
  }
}

function getStorePaths(projectId?: string) {
  if (!projectId) {
    return {
      dataRoot: LEGACY_DATA_ROOT,
      indexPath: path.join(LEGACY_DATA_ROOT, "index.json"),
    };
  }

  assertProjectId(projectId);
  const dataRoot = path.join(PROJECTS_ROOT, projectId, "submissions");
  return {
    dataRoot,
    indexPath: path.join(dataRoot, "index.json"),
  };
}

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

function isZipFile(name: string): boolean {
  return name.toLowerCase().endsWith(".zip");
}

function basenameFromZipPath(name: string): string {
  const normalized = name.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized;
}

function isZipMetadataEntry(entryName: string, filename: string): boolean {
  const normalized = entryName.replace(/\\/g, "/");
  return normalized.startsWith("__MACOSX/") || filename.startsWith("._");
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "_").trim() || "submission.py";
}

function splitNameAndExt(filename: string): { name: string; ext: string } {
  const ext = path.extname(filename);
  const name = filename.slice(0, Math.max(0, filename.length - ext.length));
  return { name, ext };
}

function stripExtension(filename: string): string {
  const ext = path.extname(filename);
  return filename.slice(0, Math.max(0, filename.length - ext.length));
}

function parseStudentIdentityFromZipOwner(ownerName: string): StudentIdentity | null {
  const normalized = stripExtension(ownerName).normalize("NFC");
  const matched = normalized.match(/^(.+?)-(\d{8})(?:_|$)/u);
  if (!matched) {
    return null;
  }

  const studentName = matched[1].trim().normalize("NFC");
  const studentId = matched[2];
  if (!studentName) {
    return null;
  }

  return {
    studentId,
    studentName,
    identitySource: "zip",
  };
}

function dedupeFilename(filename: string, existing: SubmissionMeta[]): string {
  const existingLower = new Set(
    existing.map((item) => repairFilenameMojibake(item.filename).toLowerCase()),
  );
  if (!existingLower.has(repairFilenameMojibake(filename).toLowerCase())) {
    return filename;
  }

  const { name, ext } = splitNameAndExt(filename);
  let seq = 2;
  while (true) {
    const candidate = `${name} (${seq})${ext}`;
    if (!existingLower.has(repairFilenameMojibake(candidate).toLowerCase())) {
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
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
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
  const ranked = candidates.sort(
    (a, b) => b.replace(/\u0000/g, "").length - a.replace(/\u0000/g, "").length,
  );
  return ranked[0];
}

function parseNotebookJson(buffer: Buffer): unknown {
  const candidates = [
    decodeTextWithFallback(buffer),
    buffer.toString("utf8"),
    buffer.toString("utf16le"),
    decodeUtf16Be(buffer),
  ];

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

  throw new Error(
    "ipynb JSON 파싱에 실패했습니다. 파일 인코딩 또는 형식을 확인해주세요.",
  );
}

function extractNotebookCodeCells(parsed: unknown): NotebookCodeCell[] {
  if (!parsed || typeof parsed !== "object" || !("cells" in parsed)) {
    throw new Error("유효한 ipynb 파일이 아닙니다.");
  }

  const cells = (parsed as { cells?: unknown }).cells;
  if (!Array.isArray(cells)) {
    throw new Error("ipynb cells 구조가 올바르지 않습니다.");
  }

  const codeCells: NotebookCodeCell[] = [];
  for (const cell of cells) {
    if (!cell || typeof cell !== "object") {
      continue;
    }

    const cellType = (cell as { cell_type?: unknown }).cell_type;
    if (cellType !== "code") {
      continue;
    }

    const cellId = (cell as { id?: unknown }).id;
    const source = (cell as { source?: unknown }).source;
    let code = "";
    if (Array.isArray(source)) {
      code = source
        .map((line) => (typeof line === "string" ? line : ""))
        .join("");
    } else if (typeof source === "string") {
      code = source;
    }

    if (code.trim()) {
      codeCells.push({
        id: typeof cellId === "string" && cellId.trim() ? cellId : `cell-${codeCells.length + 1}`,
        index: codeCells.length,
        source: code,
      });
    }
  }

  return codeCells;
}

function notebookToPython(notebookBuffer: Buffer): string {
  const parsed = parseNotebookJson(notebookBuffer);
  const codeCells = extractNotebookCodeCells(parsed);
  const merged = codeCells.map((cell) => cell.source).join("\n\n").trim();
  if (!merged) {
    throw new Error(EMPTY_NOTEBOOK_MESSAGE);
  }
  return merged;
}

function notebookCellsFromContent(content: string): NotebookCodeCell[] | undefined {
  try {
    return extractNotebookCodeCells(parseNotebookJson(Buffer.from(content, "utf8")));
  } catch {
    return undefined;
  }
}

function isEmptyNotebookError(error: unknown): boolean {
  return error instanceof Error && error.message === EMPTY_NOTEBOOK_MESSAGE;
}

async function ensureStore(projectId?: string) {
  const { dataRoot, indexPath } = getStorePaths(projectId);
  await fs.mkdir(dataRoot, { recursive: true });
  try {
    await fs.access(indexPath);
  } catch {
    const initial: SubmissionIndex = { items: [] };
    await fs.writeFile(indexPath, JSON.stringify(initial, null, 2), "utf8");
  }
}

async function readIndex(projectId?: string): Promise<SubmissionIndex> {
  await ensureStore(projectId);
  const { indexPath } = getStorePaths(projectId);
  const raw = await fs.readFile(indexPath, "utf8");
  const parsed = JSON.parse(raw) as SubmissionIndex;
  return {
    items: Array.isArray(parsed.items) ? parsed.items : [],
  };
}

async function writeIndex(index: SubmissionIndex, projectId?: string) {
  const { indexPath } = getStorePaths(projectId);
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");
}

export async function countSubmissions(projectId?: string): Promise<number> {
  const index = await readIndex(projectId);
  return index.items.length;
}

export async function listSubmissions(projectId?: string): Promise<SubmissionMeta[]> {
  const index = await readIndex(projectId);
  return [...index.items].reverse();
}

export async function createSubmissionFromFile(
  file: File,
  projectId?: string,
): Promise<SubmissionMeta> {
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
  await ensureStore(projectId);
  const index = await readIndex(projectId);
  const filename = dedupeFilename(rawName, index.items);

  const { dataRoot } = getStorePaths(projectId);
  const sourcePath = path.join(dataRoot, `${id}${extension}`);
  const codePath = path.join(dataRoot, `${id}.code.py`);
  await fs.writeFile(sourcePath, content, "utf8");
  await fs.writeFile(codePath, code, "utf8");

  const item: SubmissionMeta = {
    id,
    filename,
    extension,
    size: file.size,
  };

  index.items.push(item);
  await writeIndex(index, projectId);
  return item;
}

async function createSubmissionFromBuffer(params: {
  filename: string;
  rawBuffer: Buffer;
  size: number;
  studentIdentity?: StudentIdentity | null;
  zipOwnerName?: string;
  projectId?: string;
}): Promise<SubmissionMeta> {
  const rawName = sanitizeFilename(params.filename);
  const extension = extOf(rawName);

  if (!extension) {
    throw new Error(".py 또는 .ipynb 파일만 업로드할 수 있습니다.");
  }

  if (params.size > MAX_FILE_SIZE) {
    throw new Error("파일 크기는 최대 2MB까지 허용됩니다.");
  }

  const content = decodeTextWithFallback(params.rawBuffer);
  const code = extension === ".ipynb" ? notebookToPython(params.rawBuffer) : content;

  if (!code.trim()) {
    throw new Error("빈 코드 파일은 업로드할 수 없습니다.");
  }

  const id = crypto.randomUUID();
  await ensureStore(params.projectId);
  const index = await readIndex(params.projectId);
  const filename = dedupeFilename(rawName, index.items);

  const { dataRoot } = getStorePaths(params.projectId);
  const sourcePath = path.join(dataRoot, `${id}${extension}`);
  const codePath = path.join(dataRoot, `${id}.code.py`);
  await fs.writeFile(sourcePath, content, "utf8");
  await fs.writeFile(codePath, code, "utf8");

  const item: SubmissionMeta = {
    id,
    filename,
    extension,
    size: params.size,
    ...(params.zipOwnerName ? { zipOwnerName: params.zipOwnerName } : {}),
    ...(params.studentIdentity
      ? {
          studentId: params.studentIdentity.studentId,
          studentName: params.studentIdentity.studentName,
          identitySource: params.studentIdentity.identitySource,
        }
      : {}),
  };

  index.items.push(item);
  await writeIndex(index, params.projectId);
  return item;
}

export async function createSubmissionsFromUpload(file: File, projectId?: string): Promise<SubmissionUploadResult> {
  if (!isZipFile(file.name)) {
    try {
      return {
        created: [await createSubmissionFromFile(file, projectId)],
        skipped: [],
      };
    } catch (error) {
      if (isEmptyNotebookError(error)) {
        return {
          created: [],
          skipped: [{ filename: sanitizeFilename(file.name), reason: EMPTY_NOTEBOOK_MESSAGE }],
        };
      }
      throw error;
    }
  }

  if (file.size > MAX_ZIP_FILE_SIZE) {
    throw new Error("zip 파일 크기는 최대 50MB까지 허용됩니다.");
  }

  const zipBuffer = Buffer.from(await file.arrayBuffer());
  const zipBaseName = sanitizeFilename(stripExtension(file.name));
  const entries = unzipSync(zipBuffer);
  const candidates = Object.entries(entries)
    .map(([rawEntryName, data]) => {
      const entryName = repairFilenameMojibake(rawEntryName);
      return {
        entryName,
        filename: sanitizeFilename(basenameFromZipPath(entryName)),
        ownerName: zipBaseName,
        data,
      };
    })
    .filter(({ entryName, filename, data }) => {
      const isDirectory = entryName.endsWith("/") || data.length === 0;
      return !isDirectory && !isZipMetadataEntry(entryName, filename) && extOf(filename) !== null;
    });

  if (candidates.length === 0) {
    throw new Error("zip 안에서 .py 또는 .ipynb 파일을 찾지 못했습니다.");
  }

  if (candidates.length > MAX_ZIP_SUBMISSIONS) {
    throw new Error(`zip 안의 제출 파일은 최대 ${MAX_ZIP_SUBMISSIONS}개까지 허용됩니다.`);
  }

  const created: SubmissionMeta[] = [];
  const skipped: SkippedSubmission[] = [];
  for (const candidate of candidates) {
    if (candidate.data.length > MAX_ZIP_ENTRY_SIZE) {
      throw new Error(`${candidate.filename} 파일 크기는 최대 2MB까지 허용됩니다.`);
    }

    const extension = extOf(candidate.filename);
    if (!extension) {
      continue;
    }
    const studentIdentity = parseStudentIdentityFromZipOwner(candidate.ownerName);

    try {
      const item = await createSubmissionFromBuffer({
        filename: candidate.filename,
        rawBuffer: Buffer.from(candidate.data),
        size: candidate.data.length,
        studentIdentity,
        zipOwnerName: candidate.ownerName,
        projectId,
      });
      created.push(item);
    } catch (error) {
      if (isEmptyNotebookError(error)) {
        skipped.push({ filename: candidate.filename, reason: EMPTY_NOTEBOOK_MESSAGE });
        continue;
      }
      throw error;
    }
  }

  return { created, skipped };
}

export async function getSubmissionById(
  id: string,
  projectId?: string,
): Promise<SubmissionDetail | null> {
  const index = await readIndex(projectId);
  const item = index.items.find((entry) => entry.id === id);
  if (!item) {
    return null;
  }

  const { dataRoot } = getStorePaths(projectId);
  const codePath = path.join(dataRoot, `${item.id}.code.py`);
  try {
    const code = await fs.readFile(codePath, "utf8");
    if (item.extension !== ".ipynb") {
      return { ...item, code };
    }

    const sourcePath = path.join(dataRoot, `${item.id}${item.extension}`);
    const sourceContent = await fs.readFile(sourcePath, "utf8");
    return { ...item, code, notebookCells: notebookCellsFromContent(sourceContent) };
  } catch {
    return null;
  }
}

export async function listSubmissionDetails(projectId?: string): Promise<SubmissionDetail[]> {
  const index = await readIndex(projectId);
  const sorted = [...index.items].reverse();
  const { dataRoot } = getStorePaths(projectId);
  const details = await Promise.all(
    sorted.map(async (item) => {
      const codePath = path.join(dataRoot, `${item.id}.code.py`);
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

export async function getSubmissionSourceById(
  id: string,
  projectId?: string,
): Promise<SubmissionSource | null> {
  const index = await readIndex(projectId);
  const item = index.items.find((entry) => entry.id === id);
  if (!item) {
    return null;
  }

  const { dataRoot } = getStorePaths(projectId);
  const sourcePath = path.join(dataRoot, `${item.id}${item.extension}`);
  try {
    const content = await fs.readFile(sourcePath, "utf8");
    return { ...item, content };
  } catch {
    return null;
  }
}

export async function deleteSubmissionsByIds(
  ids: string[],
  projectId?: string,
): Promise<{ deletedCount: number }> {
  if (ids.length === 0) {
    return { deletedCount: 0 };
  }

  const idSet = new Set(ids);
  const index = await readIndex(projectId);
  const targets = index.items.filter((item) => idSet.has(item.id));
  const { dataRoot } = getStorePaths(projectId);

  await Promise.all(
    targets.map(async (item) => {
      const sourcePath = path.join(dataRoot, `${item.id}${item.extension}`);
      const codePath = path.join(dataRoot, `${item.id}.code.py`);
      await fs.rm(sourcePath, { force: true });
      await fs.rm(codePath, { force: true });
    }),
  );

  index.items = index.items.filter((item) => !idSet.has(item.id));
  await writeIndex(index, projectId);
  return { deletedCount: targets.length };
}

export async function deleteProjectSubmissionStore(projectId: string): Promise<void> {
  assertProjectId(projectId);
  await fs.rm(path.join(PROJECTS_ROOT, projectId), { recursive: true, force: true });
}
