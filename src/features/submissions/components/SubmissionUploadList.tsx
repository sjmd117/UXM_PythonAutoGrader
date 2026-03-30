"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";

type SubmissionMeta = {
  id: string;
  filename: string;
  extension: ".py" | ".ipynb";
  uploadedAt: string;
  size: number;
};

type ApiListResponse = {
  ok: boolean;
  items: SubmissionMeta[];
};

type TestCase = {
  input: string;
  expectedOutput: string;
  weight: number;
};

type BatchCaseResult = {
  index: number;
  passed: boolean;
  status: "passed" | "failed" | "runtime_error" | "timeout";
};

type BatchSubmissionResult = {
  id: string;
  filename: string;
  extension: ".py" | ".ipynb";
  uploadedAt: string;
  score: number;
  maxScore: number;
  allPassed: boolean;
  failedCaseCount: number;
  results: BatchCaseResult[];
};

type BatchGradeResponse = {
  ok: boolean;
  pythonCommand: string;
  testCaseCount: number;
  submissions: BatchSubmissionResult[];
};

const DEFAULT_CASES: TestCase[] = [
  { input: "2", expectedOutput: "4", weight: 5 },
  { input: "10", expectedOutput: "20", weight: 5 },
];

function shortId(id: string): string {
  return id.slice(0, 8);
}

export default function SubmissionUploadList() {
  const [items, setItems] = useState<SubmissionMeta[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [isGrading, setIsGrading] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<FileList | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [testCases, setTestCases] = useState<TestCase[]>(DEFAULT_CASES);
  const [timeoutMs, setTimeoutMs] = useState(2000);
  const [batchResult, setBatchResult] = useState<BatchGradeResponse | null>(null);

  const maxScore = useMemo(
    () => testCases.reduce((acc, item) => acc + (Number.isFinite(item.weight) ? item.weight : 0), 0),
    [testCases],
  );

  const allChecked = items.length > 0 && selectedIds.length === items.length;
  const caseScrollClass = testCases.length > 2 ? "max-h-[420px] overflow-y-auto pr-1" : "";

  const loadItems = async () => {
    setError(null);
    const response = await fetch("/api/submissions", { cache: "no-store" });
    const payload = (await response.json()) as ApiListResponse | { error: string };

    if (!response.ok || !("items" in payload)) {
      throw new Error("error" in payload ? payload.error : "목록 조회에 실패했습니다.");
    }

    setItems(payload.items);
    setSelectedIds((prev) => prev.filter((id) => payload.items.some((item) => item.id === id)));
  };

  useEffect(() => {
    const run = async () => {
      try {
        await loadItems();
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "오류가 발생했습니다.");
      } finally {
        setIsLoading(false);
      }
    };

    void run();
  }, []);

  const updateCase = (index: number, patch: Partial<TestCase>) => {
    setTestCases((prev) => prev.map((tc, i) => (i === index ? { ...tc, ...patch } : tc)));
  };

  const addCase = () => {
    setTestCases((prev) => [...prev, { input: "", expectedOutput: "", weight: 1 }]);
  };

  const removeCase = (index: number) => {
    setTestCases((prev) => prev.filter((_, i) => i !== index));
  };

  const toggleSelection = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]));
  };

  const toggleAllSelection = () => {
    if (allChecked) {
      setSelectedIds([]);
      return;
    }
    setSelectedIds(items.map((item) => item.id));
  };

  const onUpload = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!selectedFiles || selectedFiles.length === 0) {
      setError("업로드할 파일을 선택해주세요.");
      return;
    }

    setIsUploading(true);

    try {
      const formData = new FormData();
      for (const file of Array.from(selectedFiles)) {
        formData.append("files", file);
      }

      const response = await fetch("/api/submissions", {
        method: "POST",
        body: formData,
      });

      const payload = (await response.json()) as { ok: boolean } | { error: string };
      if (!response.ok || !("ok" in payload)) {
        throw new Error("error" in payload ? payload.error : "업로드에 실패했습니다.");
      }

      await loadItems();
      setBatchResult(null);
      setSelectedFiles(null);
      const input = document.getElementById("file-upload") as HTMLInputElement | null;
      if (input) {
        input.value = "";
      }
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "업로드 중 오류가 발생했습니다.");
    } finally {
      setIsUploading(false);
    }
  };

  const onBatchGrade = async () => {
    setError(null);
    setBatchResult(null);

    if (items.length === 0) {
      setError("먼저 파일을 업로드해주세요.");
      return;
    }

    if (testCases.length === 0) {
      setError("최소 1개의 테스트케이스가 필요합니다.");
      return;
    }

    setIsGrading(true);
    try {
      const response = await fetch("/api/grade/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testCases, timeoutMs }),
      });

      const payload = (await response.json()) as BatchGradeResponse | { error: string };
      if (!response.ok || !("submissions" in payload)) {
        throw new Error("error" in payload ? payload.error : "일괄 채점에 실패했습니다.");
      }

      setBatchResult(payload);
    } catch (gradeError) {
      setError(gradeError instanceof Error ? gradeError.message : "채점 중 오류가 발생했습니다.");
    } finally {
      setIsGrading(false);
    }
  };

  const onDownloadSelected = async () => {
    if (selectedIds.length === 0) {
      setError("다운로드할 파일을 선택해주세요.");
      return;
    }

    setError(null);
    setIsDownloading(true);
    try {
      for (const id of selectedIds) {
        const response = await fetch(`/api/submissions/${id}/download`);
        if (!response.ok) {
          const payload = (await response.json()) as { error?: string };
          throw new Error(payload.error ?? "파일 다운로드에 실패했습니다.");
        }

        const blob = await response.blob();
        const disposition = response.headers.get("Content-Disposition") ?? "";
        const matched = disposition.match(/filename\*=UTF-8''(.+)$/);
        const filename = matched ? decodeURIComponent(matched[1]) : `${id}.py`;

        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
      }
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "다운로드 중 오류가 발생했습니다.");
    } finally {
      setIsDownloading(false);
    }
  };

  const onDeleteSelected = async () => {
    if (selectedIds.length === 0) {
      setError("삭제할 파일을 선택해주세요.");
      return;
    }

    const accepted = window.confirm(`선택한 ${selectedIds.length}개 파일을 삭제할까요?`);
    if (!accepted) {
      return;
    }

    setError(null);
    setIsDeleting(true);
    try {
      const response = await fetch("/api/submissions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedIds }),
      });

      const payload = (await response.json()) as { ok: boolean } | { error: string };
      if (!response.ok || !("ok" in payload)) {
        throw new Error("error" in payload ? payload.error : "삭제에 실패했습니다.");
      }

      setSelectedIds([]);
      setBatchResult(null);
      await loadItems();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "삭제 중 오류가 발생했습니다.");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,#e0f2fe_0%,#dbeafe_48%,#ede9fe_100%)] p-4 md:p-8">
      <main className="mx-auto max-w-5xl rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl backdrop-blur md:p-8">
        <h1 className="text-2xl font-black tracking-tight text-slate-900 md:text-4xl">Python 과제 업로드</h1>
        <p className="mt-2 text-sm text-slate-600 md:text-base">
          `.py`, `.ipynb` 파일 업로드 후 공통 테스트케이스로 전체 파일을 일괄 채점합니다.
        </p>

        <form className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4" onSubmit={onUpload}>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <input
              id="file-upload"
              type="file"
              accept=".py,.ipynb"
              multiple
              onChange={(e) => setSelectedFiles(e.target.files)}
              className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-white"
            />
            <button
              type="submit"
              disabled={isUploading}
              className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-bold text-slate-900 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {isUploading ? "업로드 중..." : "파일 업로드"}
            </button>
          </div>
        </form>

        {error && <p className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}

        <section className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-extrabold text-slate-900">업로드된 파일 리스트</h2>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-600">선택 {selectedIds.length}개</span>
              <button
                type="button"
                onClick={onDownloadSelected}
                disabled={selectedIds.length === 0 || isDownloading}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:text-slate-300"
              >
                다운로드
              </button>
              <button
                type="button"
                onClick={onDeleteSelected}
                disabled={selectedIds.length === 0 || isDeleting}
                className="inline-flex items-center gap-1 rounded-lg border border-rose-300 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 disabled:cursor-not-allowed disabled:text-rose-300"
              >
                삭제
              </button>
            </div>
          </div>

          {isLoading ? (
            <p className="mt-2 text-sm text-slate-500">불러오는 중...</p>
          ) : items.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">아직 업로드된 파일이 없습니다.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              <li className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700">
                  <input type="checkbox" checked={allChecked} onChange={toggleAllSelection} className="h-4 w-4" />
                  전체 선택
                </label>
              </li>
              {items.map((item) => (
                <li key={item.id} className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(item.id)}
                        onChange={() => toggleSelection(item.id)}
                        className="h-4 w-4"
                      />
                      <Link href={`/submissions/${item.id}`} className="text-sm font-semibold text-blue-700 underline-offset-2 hover:underline">
                        {item.filename}
                      </Link>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                        ID {shortId(item.id)}
                      </span>
                    </div>
                    <span className="text-xs text-slate-500">
                      {item.extension} · {(item.size / 1024).toFixed(1)}KB · {new Date(item.uploadedAt).toLocaleString()}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-extrabold text-slate-900">공통 테스트 케이스</h2>
            <button
              type="button"
              onClick={addCase}
              className="rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white transition hover:bg-slate-700"
            >
              + 케이스 추가
            </button>
          </div>

          <p className="mt-2 text-xs text-slate-600">
            규칙: 케이스 하나라도 틀리면 해당 파일 점수는 0점 처리됩니다. (전체 만점: {maxScore})
          </p>

          <div className={`mt-3 space-y-3 ${caseScrollClass}`}>
            {testCases.map((testCase, index) => (
              <article key={index} className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="mb-2 flex items-center justify-between">
                  <strong className="text-xs text-slate-700">Case #{index + 1}</strong>
                  <button
                    type="button"
                    onClick={() => removeCase(index)}
                    disabled={testCases.length === 1}
                    className="text-xs text-rose-600 disabled:cursor-not-allowed disabled:text-slate-300"
                  >
                    삭제
                  </button>
                </div>
                <textarea
                  value={testCase.input}
                  onChange={(e) => updateCase(index, { input: e.target.value })}
                  placeholder="입력값"
                  className="mb-2 h-20 w-full resize-none rounded-xl border border-slate-200 p-2 text-xs outline-none ring-amber-300 transition focus:ring-2"
                />
                <textarea
                  value={testCase.expectedOutput}
                  onChange={(e) => updateCase(index, { expectedOutput: e.target.value })}
                  placeholder="기대 출력"
                  className="mb-2 h-20 w-full resize-none rounded-xl border border-slate-200 p-2 text-xs outline-none ring-amber-300 transition focus:ring-2"
                />
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={testCase.weight}
                  onChange={(e) => updateCase(index, { weight: Number(e.target.value) })}
                  className="w-full rounded-xl border border-slate-200 p-2 text-xs outline-none ring-amber-300 transition focus:ring-2"
                  placeholder="배점"
                />
              </article>
            ))}
          </div>

          <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-2">
              <label htmlFor="timeout" className="text-xs font-semibold text-slate-700">
                케이스별 제한 시간(ms)
              </label>
              <input
                id="timeout"
                type="number"
                min={100}
                max={20000}
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(Number(e.target.value))}
                className="w-36 rounded-xl border border-slate-300 p-2 text-xs outline-none ring-amber-300 transition focus:ring-2"
              />
            </div>
            <button
              type="button"
              onClick={onBatchGrade}
              disabled={isGrading || isLoading}
              className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-bold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {isGrading ? "채점 중..." : "채점 시작"}
            </button>
          </div>
        </section>

        {batchResult && (
          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-4">
            <h2 className="text-lg font-extrabold text-slate-900">일괄 채점 결과</h2>
            <p className="mt-1 text-sm text-slate-600">
              테스트케이스 {batchResult.testCaseCount}개 · 실행기: {batchResult.pythonCommand}
            </p>

            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-100 text-left text-slate-700">
                    <th className="px-3 py-2">파일명</th>
                    <th className="px-3 py-2">점수</th>
                    <th className="px-3 py-2">상태</th>
                    <th className="px-3 py-2">실패 케이스 수</th>
                  </tr>
                </thead>
                <tbody>
                  {batchResult.submissions.map((item) => (
                    <tr key={item.id} className="border-b border-slate-100">
                      <td className="px-3 py-2">
                        <Link href={`/submissions/${item.id}`} className="text-blue-700 underline-offset-2 hover:underline">
                          {item.filename}
                        </Link>
                      </td>
                      <td className="px-3 py-2 font-semibold">
                        {item.score} / {item.maxScore}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`rounded-full px-2 py-1 text-xs font-semibold ${
                            item.allPassed ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-700"
                          }`}
                        >
                          {item.allPassed ? "통과" : "0점 처리"}
                        </span>
                      </td>
                      <td className="px-3 py-2">{item.failedCaseCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
