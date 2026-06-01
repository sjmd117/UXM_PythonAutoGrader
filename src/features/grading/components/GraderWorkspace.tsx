"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";
import TestCaseEditor, { type TestCase } from "@/features/grading/components/TestCaseEditor";
import { formatGradeStatus, parseForbiddenMethodsInput } from "@/features/grading/lib/forbidden-methods";
import { repairFilenameMojibake } from "@/lib/repair-filename";
import { useStoredState } from "@/lib/use-stored-state";

type GradeResult = {
  index: number;
  passed: boolean;
  scoreEarned: number;
  scoreTotal: number;
  actualOutput: string;
  expectedOutput: string;
  error?: string;
  runtimeMs: number;
  status: "passed" | "failed" | "runtime_error" | "timeout" | "forbidden_method";
};

type GradeResponse = {
  ok: boolean;
  summary: {
    totalScore: number;
    maxScore: number;
    passedCount: number;
    totalCount: number;
    accepted?: boolean;
  };
  results: GradeResult[];
  pythonCommand: string;
};

type NotebookCodeCell = {
  id: string;
  index: number;
  source: string;
};

type CellRunResult = {
  ok: boolean;
  pythonCommand: string;
  stdout: string;
  stderr: string;
  status: "ok" | "runtime_error" | "timeout" | "forbidden_method";
  runtimeMs: number;
};

type Props = {
  projectId?: string;
  projectName?: string;
  submissionId: string;
  filename: string;
  initialCode: string;
  notebookCells?: NotebookCodeCell[];
};

const createDefaultCase = (): TestCase => ({
  input: "",
  expectedOutput: "",
  weight: "",
});

const DEFAULT_TEST_CASES = [createDefaultCase()];

function mergeNotebookCells(cells: NotebookCodeCell[]): string {
  return cells.map((cell) => cell.source.trimEnd()).filter(Boolean).join("\n\n");
}

function createCellId(): string {
  return `cell-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function runStatusLabel(status: CellRunResult["status"]): string {
  switch (status) {
    case "ok":
      return "실행 완료";
    case "runtime_error":
      return "실행 오류";
    case "timeout":
      return "시간 초과";
    case "forbidden_method":
      return "금지 메소드";
  }
}

function storagePrefix(projectId: string | undefined, submissionId: string): string {
  return projectId
    ? `uxm-grader:project:${projectId}:submission:${submissionId}`
    : `uxm-grader:submission:${submissionId}`;
}

export default function GraderWorkspace({ projectId, projectName, submissionId, filename, initialCode, notebookCells = [] }: Props) {
  const displayFilename = repairFilenameMojibake(filename);
  const storageKeyPrefix = storagePrefix(projectId, submissionId);
  const backHref = projectId ? `/projects/${projectId}` : "/";
  const projectListHref = "/";
  const [code, setCode] = useStoredState(`${storageKeyPrefix}:code`, initialCode);
  const [cellInput, setCellInput] = useStoredState(`${storageKeyPrefix}:cell-input`, "");
  const [notebookCellDrafts, setNotebookCellDrafts] = useStoredState<NotebookCodeCell[]>(
    `${storageKeyPrefix}:notebook-cells`,
    notebookCells,
  );
  const [testCases, setTestCases] = useStoredState<TestCase[]>(
    `${storageKeyPrefix}:test-cases`,
    DEFAULT_TEST_CASES,
  );
  const [timeoutMs, setTimeoutMs] = useStoredState(`${storageKeyPrefix}:timeout-ms`, 2000);
  const [forbiddenMethodsInput, setForbiddenMethodsInput] = useStoredState(
    `${storageKeyPrefix}:forbidden-methods`,
    "",
  );
  const [isLoading, setIsLoading] = useState(false);
  const [runningCellId, setRunningCellId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cellRunResults, setCellRunResults] = useState<Record<string, CellRunResult>>({});
  const [result, setResult] = useStoredState<GradeResponse | null>(`${storageKeyPrefix}:result`, null);

  const hasNotebookCells = notebookCellDrafts.length > 0;
  const maxScore = useMemo(
    () => testCases.reduce((acc, tc) => acc + (typeof tc.weight === "number" ? tc.weight : 0), 0),
    [testCases],
  );

  const syncNotebookCells = (nextCells: NotebookCodeCell[]) => {
    const normalized = nextCells.map((cell, index) => ({ ...cell, index }));
    setNotebookCellDrafts(normalized);
    setCode(mergeNotebookCells(normalized));
    setResult(null);
  };

  const updateNotebookCell = (cellId: string, source: string) => {
    syncNotebookCells(notebookCellDrafts.map((cell) => (cell.id === cellId ? { ...cell, source } : cell)));
  };

  const mergeCellWithNext = (index: number) => {
    if (index < 0 || index >= notebookCellDrafts.length - 1) {
      return;
    }

    const current = notebookCellDrafts[index];
    const next = notebookCellDrafts[index + 1];
    syncNotebookCells([
      ...notebookCellDrafts.slice(0, index),
      { ...current, source: `${current.source.trimEnd()}\n\n${next.source.trimStart()}` },
      ...notebookCellDrafts.slice(index + 2),
    ]);
  };

  const mergeAllCells = () => {
    if (!hasNotebookCells) {
      return;
    }

    syncNotebookCells([
      {
        id: createCellId(),
        index: 0,
        source: mergeNotebookCells(notebookCellDrafts),
      },
    ]);
  };

  const restoreOriginalCells = () => {
    setNotebookCellDrafts(notebookCells);
    setCode(initialCode);
    setCellRunResults({});
    setResult(null);
  };

  const runNotebookCell = async (cellId: string, mode: "single" | "through") => {
    const cellIndex = notebookCellDrafts.findIndex((cell) => cell.id === cellId);
    if (cellIndex === -1) {
      return;
    }

    const cellsToRun = mode === "single" ? [notebookCellDrafts[cellIndex]] : notebookCellDrafts.slice(0, cellIndex + 1);
    const codeToRun = mergeNotebookCells(cellsToRun);
    setError(null);
    setRunningCellId(cellId);

    try {
      const response = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: codeToRun,
          stdin: cellInput,
          timeoutMs,
          forbiddenMethods: parseForbiddenMethodsInput(forbiddenMethodsInput),
        }),
      });

      const payload = (await response.json()) as CellRunResult | { error: string };
      if (!response.ok || !("stdout" in payload)) {
        throw new Error("error" in payload ? payload.error : "셀 실행에 실패했습니다.");
      }

      setCellRunResults((prev) => ({ ...prev, [cellId]: payload }));
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "셀 실행 중 오류가 발생했습니다.");
    } finally {
      setRunningCellId(null);
    }
  };

  const updateCase = (index: number, patch: Partial<TestCase>) => {
    setTestCases((prev) => prev.map((tc, i) => (i === index ? { ...tc, ...patch } : tc)));
  };

  const addCase = () => {
    setTestCases((prev) => [...prev, createDefaultCase()]);
  };

  const removeCase = (index: number) => {
    setTestCases((prev) => prev.filter((_, i) => i !== index));
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setResult(null);
    setIsLoading(true);

    try {
      const response = await fetch("/api/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          testCases: testCases.map((item) => ({
            input: item.input,
            expectedOutput: item.expectedOutput,
            weight: item.weight === "" ? undefined : item.weight,
          })),
          timeoutMs,
          forbiddenMethods: parseForbiddenMethodsInput(forbiddenMethodsInput),
        }),
      });

      const payload = (await response.json()) as GradeResponse | { error: string };
      if (!response.ok) {
        throw new Error("error" in payload ? payload.error : "채점 요청이 실패했습니다.");
      }

      setResult(payload as GradeResponse);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "알 수 없는 오류가 발생했습니다.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,#fef3c7_0%,#e0f2fe_50%,#eef2ff_100%)] p-4 md:p-8">
      <main className="mx-auto max-w-6xl rounded-3xl border border-black/10 bg-white/80 p-5 shadow-xl backdrop-blur md:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900 md:text-4xl">채점 상세 페이지</h1>
            {projectName && <p className="mt-1 text-xs font-bold uppercase tracking-wide text-emerald-700">{projectName}</p>}
            <p className="mt-1 text-sm text-slate-600">파일: {displayFilename}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {projectId && (
              <Link href={projectListHref} className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700">
                과제 목록
              </Link>
            )}
            <Link href={backHref} className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
              {projectId ? "프로젝트 파일 목록" : "파일 목록"}
            </Link>
          </div>
        </div>

        <p className="mt-3 text-xs text-slate-500">Submission ID: {submissionId}</p>

        <form className="mt-6 grid gap-6 lg:grid-cols-[1.2fr_1fr]" onSubmit={onSubmit}>
          <section className="space-y-3">
            {hasNotebookCells && (
              <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-slate-700">ipynb code cell 편집</h2>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={mergeAllCells}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700"
                    >
                      전체 병합
                    </button>
                    <button
                      type="button"
                      onClick={restoreOriginalCells}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700"
                    >
                      원본 복원
                    </button>
                  </div>
                </div>

                <textarea
                  value={cellInput}
                  onChange={(event) => setCellInput(event.target.value)}
                  placeholder="셀 실행 입력값"
                  className="h-16 w-full resize-none rounded-xl border border-slate-300 bg-white p-2 text-xs outline-none ring-amber-300 transition focus:ring-2"
                />

                <div className="max-h-[460px] space-y-3 overflow-y-auto pr-1">
                  {notebookCellDrafts.map((cell, index) => {
                    const cellResult = cellRunResults[cell.id];
                    const isRunning = runningCellId === cell.id;

                    return (
                      <article key={cell.id} className="rounded-xl border border-slate-200 bg-white p-3">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <strong className="text-xs text-slate-700">Cell #{index + 1}</strong>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => runNotebookCell(cell.id, "single")}
                              disabled={Boolean(runningCellId)}
                              className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                            >
                              {isRunning ? "실행 중..." : "셀 실행"}
                            </button>
                            <button
                              type="button"
                              onClick={() => runNotebookCell(cell.id, "through")}
                              disabled={Boolean(runningCellId)}
                              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:text-slate-300"
                            >
                              여기까지 실행
                            </button>
                            {index < notebookCellDrafts.length - 1 && (
                              <button
                                type="button"
                                onClick={() => mergeCellWithNext(index)}
                                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700"
                              >
                                아래와 병합
                              </button>
                            )}
                          </div>
                        </div>

                        <textarea
                          value={cell.source}
                          onChange={(event) => updateNotebookCell(cell.id, event.target.value)}
                          className="h-36 w-full resize-y rounded-xl border border-slate-300 bg-slate-950 p-3 font-mono text-xs text-emerald-300 outline-none ring-amber-300 transition focus:ring-2"
                          spellCheck={false}
                        />

                        {cellResult && (
                          <div
                            className={`mt-2 rounded-xl border p-2 text-xs ${
                              cellResult.status === "ok"
                                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                                : "border-rose-200 bg-rose-50 text-rose-900"
                            }`}
                          >
                            <p className="font-semibold">
                              {runStatusLabel(cellResult.status)} · {cellResult.runtimeMs}ms · 실행기: {cellResult.pythonCommand}
                            </p>
                            <p className="mt-1 whitespace-pre-wrap">output: {cellResult.stdout || "(빈 값)"}</p>
                            {cellResult.stderr && <p className="mt-1 whitespace-pre-wrap">error: {cellResult.stderr}</p>}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </div>
            )}

            <label className="text-sm font-semibold text-slate-700" htmlFor="python-code">
              {hasNotebookCells ? "병합된 채점 코드" : "Python 코드"}
            </label>
            <textarea
              id="python-code"
              value={code}
              readOnly
              className="h-[420px] w-full cursor-not-allowed rounded-2xl border border-slate-300 bg-slate-950 p-4 font-mono text-sm text-emerald-300 outline-none"
              spellCheck={false}
            />
          </section>

          <section className="space-y-3">
            <TestCaseEditor
              testCases={testCases}
              onAddCase={addCase}
              onRemoveCase={removeCase}
              onUpdateCase={updateCase}
              listClassName="max-h-[355px] space-y-3 overflow-y-auto pr-1"
            />

            <label className="block text-sm font-semibold text-slate-700" htmlFor="forbidden-methods">
              금지 메소드
            </label>
            <textarea
              id="forbidden-methods"
              value={forbiddenMethodsInput}
              onChange={(event) => setForbiddenMethodsInput(event.target.value)}
              placeholder="sorted, sort, list.sort"
              className="h-20 w-full resize-none rounded-xl border border-slate-300 p-2 text-sm outline-none ring-amber-300 transition focus:ring-2"
            />

            <label className="block text-sm font-semibold text-slate-700" htmlFor="timeout">
              케이스별 제한 시간(ms)
            </label>
            <input
              id="timeout"
              type="number"
              min={100}
              max={20000}
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(Number(e.target.value))}
              className="w-full rounded-xl border border-slate-300 p-2 text-sm outline-none ring-amber-300 transition focus:ring-2"
            />

            <button
              type="submit"
              disabled={isLoading}
              className="w-full rounded-2xl bg-amber-500 px-5 py-3 text-sm font-bold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {isLoading ? "채점 중..." : "자동 채점 실행"}
            </button>

            <p className="text-xs text-slate-500">총 배점: {maxScore}</p>
          </section>
        </form>

        {error && <p className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}

        {result && (
          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-4">
            <h3 className="text-lg font-black text-slate-900">채점 결과</h3>
            <p className="mt-1 text-sm text-slate-600">
              점수 {result.summary.totalScore} / {result.summary.maxScore} · 통과 {result.summary.passedCount} / {result.summary.totalCount} ·{" "}
              {result.summary.accepted ?? result.summary.totalScore > 0 ? "정답 처리" : "0점 처리"} · 실행기: {result.pythonCommand}
            </p>

            <div className="mt-4 space-y-2">
              {result.results.map((item) => {
                const input = testCases[item.index]?.input ?? "";

                return (
                  <article
                    key={item.index}
                    className={`rounded-xl border p-3 text-sm ${item.passed ? "border-emerald-300 bg-emerald-50" : "border-rose-300 bg-rose-50"}`}
                  >
                    <p className="font-semibold">
                      Case #{item.index + 1} · {item.scoreEarned}/{item.scoreTotal}점 · {formatGradeStatus(item.status)} · {item.runtimeMs}ms
                    </p>
                    <div className="mt-1 space-y-1">
                      <p className="whitespace-pre-wrap">input: {input || "(빈 값)"}</p>
                      <p className="whitespace-pre-wrap">expected: {item.expectedOutput || "(빈 값)"}</p>
                      <p className="whitespace-pre-wrap">actual: {item.actualOutput || "(빈 값)"}</p>
                    </div>
                    {item.error && <p className="mt-1 whitespace-pre-wrap text-rose-700">error: {item.error}</p>}
                  </article>
                );
              })}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
