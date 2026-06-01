import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { countSubmissions, deleteProjectSubmissionStore } from "@/features/submissions/server/submissions-repository";

export type ProjectMeta = {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectListItem = ProjectMeta & {
  submissionCount: number;
};

type ProjectIndex = {
  items: ProjectMeta[];
};

const PROJECTS_ROOT = path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "projects");
const PROJECTS_INDEX_PATH = path.join(PROJECTS_ROOT, "index.json");

function normalizeProjectName(value: unknown): string {
  return typeof value === "string" ? value.trim().normalize("NFC") : "";
}

async function ensureProjectStore() {
  await fs.mkdir(PROJECTS_ROOT, { recursive: true });
  try {
    await fs.access(PROJECTS_INDEX_PATH);
  } catch {
    await fs.writeFile(PROJECTS_INDEX_PATH, JSON.stringify({ items: [] }, null, 2), "utf8");
  }
}

async function readProjectIndex(): Promise<ProjectIndex> {
  await ensureProjectStore();
  const raw = await fs.readFile(PROJECTS_INDEX_PATH, "utf8");
  const parsed = JSON.parse(raw) as ProjectIndex;
  return {
    items: Array.isArray(parsed.items) ? parsed.items : [],
  };
}

async function writeProjectIndex(index: ProjectIndex) {
  await fs.writeFile(PROJECTS_INDEX_PATH, JSON.stringify(index, null, 2), "utf8");
}

export async function listProjects(): Promise<ProjectListItem[]> {
  const index = await readProjectIndex();
  const sorted = [...index.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return Promise.all(
    sorted.map(async (project) => ({
      ...project,
      submissionCount: await countSubmissions(project.id),
    })),
  );
}

export async function getProjectById(id: string): Promise<ProjectMeta | null> {
  const index = await readProjectIndex();
  return index.items.find((project) => project.id === id) ?? null;
}

export async function createProject(params: {
  name: string;
  description?: string;
}): Promise<ProjectMeta> {
  const name = normalizeProjectName(params.name);
  if (!name) {
    throw new Error("과제명을 입력해주세요.");
  }

  if (name.length > 80) {
    throw new Error("과제명은 80자 이하로 입력해주세요.");
  }

  const description = normalizeProjectName(params.description);
  const now = new Date().toISOString();
  const project: ProjectMeta = {
    id: crypto.randomUUID(),
    name,
    ...(description ? { description } : {}),
    createdAt: now,
    updatedAt: now,
  };

  const index = await readProjectIndex();
  index.items.push(project);
  await writeProjectIndex(index);
  return project;
}

export async function deleteProjectById(id: string): Promise<{ deleted: boolean }> {
  const index = await readProjectIndex();
  const exists = index.items.some((project) => project.id === id);
  if (!exists) {
    return { deleted: false };
  }

  index.items = index.items.filter((project) => project.id !== id);
  await writeProjectIndex(index);
  await deleteProjectSubmissionStore(id);
  return { deleted: true };
}
