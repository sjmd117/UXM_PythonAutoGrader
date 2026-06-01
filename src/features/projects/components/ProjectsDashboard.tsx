"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

type ProjectListItem = {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  submissionCount: number;
};

type ProjectListResponse = {
  ok: boolean;
  items: ProjectListItem[];
};

type ProjectCreateResponse = {
  ok: boolean;
  project: ProjectListItem;
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default function ProjectsDashboard() {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = async () => {
    setError(null);
    const response = await fetch("/api/projects", { cache: "no-store" });
    const payload = (await response.json()) as ProjectListResponse | { error: string };
    if (!response.ok || !("items" in payload)) {
      throw new Error("error" in payload ? payload.error : "과제 목록을 불러오지 못했습니다.");
    }
    setProjects(payload.items);
  };

  useEffect(() => {
    const run = async () => {
      try {
        await loadProjects();
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "과제 목록 조회 중 오류가 발생했습니다.");
      } finally {
        setIsLoading(false);
      }
    };

    void run();
  }, []);

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("과제명을 입력해주세요.");
      return;
    }

    setIsCreating(true);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      const payload = (await response.json()) as ProjectCreateResponse | { error: string };
      if (!response.ok || !("project" in payload)) {
        throw new Error("error" in payload ? payload.error : "과제 생성에 실패했습니다.");
      }

      setName("");
      setDescription("");
      await loadProjects();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "과제 생성 중 오류가 발생했습니다.");
    } finally {
      setIsCreating(false);
    }
  };

  const onDelete = async (project: ProjectListItem) => {
    const accepted = window.confirm(
      `"${project.name}" 과제를 삭제할까요?\n업로드된 제출 파일 ${project.submissionCount}개도 함께 삭제됩니다.`,
    );
    if (!accepted) {
      return;
    }

    setError(null);
    setDeletingId(project.id);
    try {
      const response = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
      const payload = (await response.json()) as { ok: boolean } | { error: string };
      if (!response.ok || !("ok" in payload)) {
        throw new Error("error" in payload ? payload.error : "과제 삭제에 실패했습니다.");
      }
      await loadProjects();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "과제 삭제 중 오류가 발생했습니다.");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 p-4 md:p-8">
      <main className="mx-auto max-w-6xl">
        <div className="flex flex-col gap-2 border-b border-slate-300 pb-5 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-950 md:text-4xl">과제 관리</h1>
            <p className="mt-2 text-sm text-slate-600">
              과제별로 제출 파일과 채점 작업을 분리해서 관리합니다.
            </p>
          </div>
          <p className="text-sm font-semibold text-slate-700">총 {projects.length}개 과제</p>
        </div>

        <form className="mt-6 grid gap-3 border border-slate-300 bg-white p-4 md:grid-cols-[1fr_1.4fr_auto]" onSubmit={onCreate}>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="과제명"
            className="min-h-11 rounded-md border border-slate-300 px-3 text-sm outline-none ring-emerald-300 focus:ring-2"
          />
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="설명"
            className="min-h-11 rounded-md border border-slate-300 px-3 text-sm outline-none ring-emerald-300 focus:ring-2"
          />
          <button
            type="submit"
            disabled={isCreating}
            className="min-h-11 rounded-md bg-slate-950 px-5 text-sm font-bold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {isCreating ? "생성 중..." : "프로젝트 생성"}
          </button>
        </form>

        {error && <p className="mt-4 border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}

        <section className="mt-6">
          {isLoading ? (
            <p className="text-sm text-slate-500">과제 목록을 불러오는 중...</p>
          ) : projects.length === 0 ? (
            <div className="border border-dashed border-slate-300 bg-white p-8 text-center">
              <h2 className="text-lg font-bold text-slate-900">아직 생성된 과제가 없습니다.</h2>
              <p className="mt-2 text-sm text-slate-500">위 입력창에서 첫 과제를 만들면 채점 화면으로 들어갈 수 있습니다.</p>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {projects.map((project) => (
                <article key={project.id} className="flex min-h-48 flex-col border border-slate-300 bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-lg font-black text-slate-950" title={project.name}>
                        {project.name}
                      </h2>
                      <p className="mt-1 line-clamp-2 min-h-10 text-sm text-slate-600">
                        {project.description || "설명이 없습니다."}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-md bg-emerald-100 px-2 py-1 text-xs font-bold text-emerald-800">
                      {project.submissionCount} files
                    </span>
                  </div>

                  <dl className="mt-4 grid gap-1 text-xs text-slate-500">
                    <div className="flex justify-between gap-3">
                      <dt>생성</dt>
                      <dd>{formatDate(project.createdAt)}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt>수정</dt>
                      <dd>{formatDate(project.updatedAt)}</dd>
                    </div>
                  </dl>

                  <div className="mt-auto flex gap-2 pt-5">
                    <Link
                      href={`/projects/${project.id}`}
                      className="flex-1 rounded-md bg-emerald-600 px-3 py-2 text-center text-sm font-bold text-white transition hover:bg-emerald-700"
                    >
                      채점하기
                    </Link>
                    <button
                      type="button"
                      onClick={() => onDelete(project)}
                      disabled={deletingId === project.id}
                      className="rounded-md border border-rose-300 bg-white px-3 py-2 text-sm font-bold text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:text-rose-300"
                    >
                      {deletingId === project.id ? "삭제 중..." : "삭제"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
