"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import TestCaseEditor, { type TestCase } from "@/features/grading/components/TestCaseEditor";
import { parseForbiddenMethodsInput } from "@/features/grading/lib/forbidden-methods";
import { repairFilenameMojibake } from "@/lib/repair-filename";
import { useStoredState, writeStoredValue } from "@/lib/use-stored-state";

type SubmissionMeta = {
  id: string;
  filename: string;
  extension: ".py" | ".ipynb";
  size: number;
  studentId?: string;
  studentName?: string;
  identitySource?: "zip" | "filename";
  zipOwnerName?: string;
};

type ApiListResponse = {
  ok: boolean;
  items: SubmissionMeta[];
};

type SkippedUpload = {
  filename: string;
  reason: string;
};

type UploadResponse = {
  ok: boolean;
  created: SubmissionMeta[];
  skipped?: SkippedUpload[];
};

type BatchCaseResult = {
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

type BatchSubmissionResult = {
  id: string;
  filename: string;
  extension: ".py" | ".ipynb";
  score: number;
  maxScore: number;
  accepted?: boolean;
  allPassed: boolean;
  passedCaseCount?: number;
  failedCaseCount: number;
  results: BatchCaseResult[];
};

type BatchGradeResponse = {
  ok: boolean;
  pythonCommand: string;
  testCaseCount: number;
  submissions: BatchSubmissionResult[];
};

type StoredGradeResponse = {
  ok: boolean;
  summary: {
    totalScore: number;
    maxScore: number;
    passedCount: number;
    totalCount: number;
    accepted?: boolean;
  };
  results: BatchCaseResult[];
  pythonCommand: string;
};

type ParsedStudentSubmission = {
  item: SubmissionMeta;
  studentId: string;
  name: string;
};

type UnmatchedStudentSubmission = {
  item: SubmissionMeta;
  reason: string;
};

type ManualStudentInfo = {
  studentId: string;
  name: string;
};

type ManualStudentInfoMap = Record<string, ManualStudentInfo>;

const createDefaultCase = (): TestCase => ({
  input: "",
  expectedOutput: "",
  weight: "",
});

const DEFAULT_TEST_CASES = [createDefaultCase()];

function CheckIcon({ label }: { label: string }) {
  return (
    <span
      className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"
      title={label}
      aria-label={label}
      role="img"
    >
      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden="true">
        <path d="M4.5 10.5 8 14l7.5-8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function XIcon({ label }: { label: string }) {
  return (
    <span
      className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-rose-100 text-rose-700"
      title={label}
      aria-label={label}
      role="img"
    >
      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden="true">
        <path d="m5.5 5.5 9 9m0-9-9 9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    </span>
  );
}

const STORAGE_KEYS = {
  testCases: "uxm-grader:batch:test-cases",
  timeoutMs: "uxm-grader:batch:timeout-ms",
  result: "uxm-grader:batch:result",
  forbiddenMethods: "uxm-grader:batch:forbidden-methods",
  manualStudentInfo: "uxm-grader:submissions:manual-student-info",
};

const submissionStorageKeys = (submissionId: string) => ({
  testCases: `uxm-grader:submission:${submissionId}:test-cases`,
  timeoutMs: `uxm-grader:submission:${submissionId}:timeout-ms`,
  forbiddenMethods: `uxm-grader:submission:${submissionId}:forbidden-methods`,
  result: `uxm-grader:submission:${submissionId}:result`,
});

function shortId(id: string): string {
  return id.slice(0, 8);
}

function removeExtension(filename: string): string {
  return filename.normalize("NFC").replace(/\.(ipynb|py)$/i, "");
}

function removeDuplicateSuffix(filenameWithoutExtension: string): string {
  return filenameWithoutExtension.replace(/\s*\(\d+\)\s*$/u, "").trim();
}

function parseHyphenStudentIdentity(text: string) {
  const normalizedName = removeDuplicateSuffix(removeExtension(text)).normalize("NFC");
  const matched = normalizedName.match(/^(.+?)-(\d{8})(?:_|$)/u);
  if (!matched) {
    return null;
  }

  const name = matched[1].trim().normalize("NFC");
  const studentId = matched[2];
  return name.length > 0 ? { name, studentId } : null;
}

function classifySubmissionFilename(item: SubmissionMeta): ParsedStudentSubmission | UnmatchedStudentSubmission {
  if (item.studentId && item.studentName) {
    return {
      item,
      studentId: item.studentId,
      name: item.studentName,
    };
  }

  if (item.zipOwnerName) {
    const zipIdentity = parseHyphenStudentIdentity(repairFilenameMojibake(item.zipOwnerName));
    if (zipIdentity) {
      return {
        item,
        studentId: zipIdentity.studentId,
        name: zipIdentity.name,
      };
    }
  }

  const repairedFilename = repairFilenameMojibake(item.filename);
  const normalizedName = removeDuplicateSuffix(removeExtension(repairedFilename)).normalize("NFC");
  const hyphenIdentity = parseHyphenStudentIdentity(repairedFilename);

  if (hyphenIdentity) {
    return {
      item,
      studentId: hyphenIdentity.studentId,
      name: hyphenIdentity.name,
    };
  }

  const studentIdMatch = normalizedName.match(/(?:^|_)(60\d{6})(?:_|$)/u);

  if (!studentIdMatch) {
    return {
      item,
      reason: "60으로 시작하는 8자리 학번을 찾지 못했습니다.",
    };
  }

  const studentId = studentIdMatch[1];
  const expectedTail = `_${studentId}_`;
  const tailStart = normalizedName.lastIndexOf(expectedTail);

  if (tailStart === -1) {
    return {
      item,
      reason: "학번 앞뒤 구분자가 규칙과 다릅니다.",
    };
  }

  const name = normalizedName.slice(tailStart + expectedTail.length).trim().normalize("NFC");
  if (name.length === 0) {
    return {
      item,
      reason: "학번 뒤 이름을 찾지 못했습니다.",
    };
  }

  return {
    item,
    studentId,
    name,
  };
}

function saveBatchResultsForDetailPages(
  payload: BatchGradeResponse,
  testCases: TestCase[],
  timeoutMs: number,
  forbiddenMethodsInput: string,
) {
  for (const submission of payload.submissions) {
    const keys = submissionStorageKeys(submission.id);
    const passedCount = submission.results.filter((item) => item.passed).length;
    const accepted = submission.accepted ?? submission.score > 0;
    const detailResult: StoredGradeResponse = {
      ok: true,
      pythonCommand: payload.pythonCommand,
      results: submission.results,
      summary: {
        totalScore: submission.score,
        maxScore: submission.maxScore,
        passedCount,
        totalCount: submission.results.length,
        accepted,
      },
    };

    writeStoredValue(keys.testCases, testCases);
    writeStoredValue(keys.timeoutMs, timeoutMs);
    writeStoredValue(keys.forbiddenMethods, forbiddenMethodsInput);
    writeStoredValue(keys.result, detailResult);
  }
}

export default function SubmissionUploadList() {
  const [items, setItems] = useState<SubmissionMeta[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [isGrading, setIsGrading] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<FileList | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [testCases, setTestCases] = useStoredState<TestCase[]>(STORAGE_KEYS.testCases, DEFAULT_TEST_CASES);
  const [timeoutMs, setTimeoutMs] = useStoredState(STORAGE_KEYS.timeoutMs, 2000);
  const [forbiddenMethodsInput, setForbiddenMethodsInput] = useStoredState(STORAGE_KEYS.forbiddenMethods, "");
  const [batchResult, setBatchResult] = useStoredState<BatchGradeResponse | null>(STORAGE_KEYS.result, null);
  const [manualStudentInfo, setManualStudentInfo] = useStoredState<ManualStudentInfoMap>(STORAGE_KEYS.manualStudentInfo, {});

  const maxScore = useMemo(
    () => testCases.reduce((acc, item) => acc + (typeof item.weight === "number" ? item.weight : 0), 0),
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

  useEffect(() => {
    if (!batchResult) {
      return;
    }

    saveBatchResultsForDetailPages(batchResult, testCases, timeoutMs, forbiddenMethodsInput);
  }, [batchResult, forbiddenMethodsInput, testCases, timeoutMs]);

  const updateCase = (index: number, patch: Partial<TestCase>) => {
    setTestCases((prev) => prev.map((tc, i) => (i === index ? { ...tc, ...patch } : tc)));
  };

  const addCase = () => {
    setTestCases((prev) => [...prev, createDefaultCase()]);
  };

  const removeCase = (index: number) => {
    setTestCases((prev) => prev.filter((_, i) => i !== index));
  };

  const updateManualStudentInfo = (id: string, patch: Partial<ManualStudentInfo>) => {
    setManualStudentInfo((prev) => ({
      ...prev,
      [id]: {
        studentId: prev[id]?.studentId ?? "",
        name: prev[id]?.name ?? "",
        ...patch,
      },
    }));
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
    setUploadNotice(null);

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

      const payload = (await response.json()) as UploadResponse | { error: string };
      if (!response.ok || !("ok" in payload)) {
        throw new Error("error" in payload ? payload.error : "업로드에 실패했습니다.");
      }

      await loadItems();
      if (payload.skipped && payload.skipped.length > 0) {
        const skippedNames = payload.skipped.map((item) => repairFilenameMojibake(item.filename)).join(", ");
        setUploadNotice(`실행 가능한 code cell이 없는 ipynb ${payload.skipped.length}개는 제외했습니다: ${skippedNames}`);
      }
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
        body: JSON.stringify({
          testCases: testCases.map((item) => ({
            input: item.input,
            expectedOutput: item.expectedOutput,
            weight: item.weight === "" ? undefined : item.weight,
          })),
          timeoutMs,
          forbiddenMethods: parseForbiddenMethodsInput(forbiddenMethodsInput),
        }),
      });

      const payload = (await response.json()) as BatchGradeResponse | { error: string };
      if (!response.ok || !("submissions" in payload)) {
        throw new Error("error" in payload ? payload.error : "일괄 채점에 실패했습니다.");
      }

      setBatchResult(payload);
      saveBatchResultsForDetailPages(payload, testCases, timeoutMs, forbiddenMethodsInput);
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
          `.py`, `.ipynb`, `.zip` 파일 업로드 후 공통 테스트케이스로 전체 파일을 일괄 채점합니다.
        </p>

        <form className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4" onSubmit={onUpload}>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <input
              id="file-upload"
              type="file"
              accept=".py,.ipynb,.zip,application/zip,application/x-zip-compressed"
              multiple
              onChange={(e) => setSelectedFiles(e.target.files)}
              className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-white"
            />
            <button
              type="submit"
              disabled={isUploading}
              className="min-w-[100px] whitespace-nowrap rounded-xl bg-amber-500 px-4 py-2 text-sm font-bold text-slate-900 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {isUploading ? "업로드 중..." : "파일 업로드"}
            </button>
          </div>
        </form>

        {error && <p className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
        {uploadNotice && <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">{uploadNotice}</p>}

        <section className="mt-6">
          <h2 className="text-lg font-extrabold text-slate-900">업로드된 파일 리스트</h2>

          {isLoading ? (
            <p className="mt-2 text-sm text-slate-500">불러오는 중...</p>
          ) : items.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">아직 업로드된 파일이 없습니다.</p>
          ) : (
            <>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700">
                  <input type="checkbox" checked={allChecked} onChange={toggleAllSelection} className="h-4 w-4" />
                  전체 선택
                </label>
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
              <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white">
                <table className="min-w-full table-fixed border-collapse text-sm">
                  <colgroup>
                    <col className="w-16" />
                    <col className="w-[42%]" />
                    <col className="w-32" />
                    <col className="w-28" />
                    <col className="w-20" />
                    <col className="w-32" />
                  </colgroup>
                  <thead>
                    <tr className="bg-slate-100 text-left text-slate-700">
                      <th className="px-3 py-2">선택</th>
                      <th className="px-3 py-2">파일명</th>
                      <th className="px-3 py-2">학번</th>
                      <th className="px-3 py-2">이름</th>
                      <th className="px-3 py-2">상태</th>
                      <th className="px-3 py-2">파일 정보</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => {
                      const classified = classifySubmissionFilename(item);
                      const isMatched = "studentId" in classified;
                      const manualInfo = manualStudentInfo[item.id] ?? { studentId: "", name: "" };
                      const hasManualInfo = manualInfo.studentId.trim().length > 0 && manualInfo.name.trim().length > 0;
                      const displayFilename = repairFilenameMojibake(item.filename);

                      return (
                        <tr key={item.id} className="border-b border-slate-100 last:border-b-0">
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              checked={selectedIds.includes(item.id)}
                              onChange={() => toggleSelection(item.id)}
                              className="h-4 w-4"
                              aria-label={`${displayFilename} 선택`}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex min-w-0 items-center gap-2">
                              <Link
                                href={`/submissions/${item.id}`}
                                className="min-w-0 truncate font-semibold text-blue-700 underline-offset-2 hover:underline"
                                title={displayFilename}
                              >
                                {displayFilename}
                              </Link>
                              <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                                ID {shortId(item.id)}
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            {isMatched ? (
                              <span className="font-semibold text-slate-900">{classified.studentId}</span>
                            ) : (
                              <input
                                type="text"
                                inputMode="numeric"
                                value={manualInfo.studentId}
                                onChange={(event) => updateManualStudentInfo(item.id, { studentId: event.target.value })}
                                className="w-28 rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-900 outline-none ring-amber-300 transition focus:ring-2"
                                placeholder="학번"
                              />
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {isMatched ? (
                              <span className="font-semibold text-slate-900">{classified.name}</span>
                            ) : (
                              <input
                                type="text"
                                value={manualInfo.name}
                                onChange={(event) => updateManualStudentInfo(item.id, { name: event.target.value.normalize("NFC") })}
                                className="w-24 rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-900 outline-none ring-amber-300 transition focus:ring-2"
                                placeholder="이름"
                              />
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {isMatched ? (
                              <CheckIcon label="학번과 이름 자동 추출 완료" />
                            ) : (
                              <XIcon label={hasManualInfo ? "자동 추출 실패, 직접 입력됨" : `직접 입력 필요: ${classified.reason}`} />
                            )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">
                            {item.extension} · {(item.size / 1024).toFixed(1)}KB
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

        <section className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="mb-2 text-xs text-slate-600">
            규칙: 테스트케이스 중 하나라도 맞으면 해당 파일은 정답 처리됩니다. (전체 만점: {maxScore})
          </p>

          <TestCaseEditor
            testCases={testCases}
            onAddCase={addCase}
            onRemoveCase={removeCase}
            onUpdateCase={updateCase}
            listClassName={`mt-3 space-y-3 ${caseScrollClass}`.trim()}
          />

          <label className="mt-4 block text-xs font-semibold text-slate-700" htmlFor="forbidden-methods">
            금지 메소드
          </label>
          <textarea
            id="forbidden-methods"
            value={forbiddenMethodsInput}
            onChange={(event) => setForbiddenMethodsInput(event.target.value)}
            placeholder="sorted, sort, list.sort"
            className="mt-2 h-20 w-full resize-none rounded-xl border border-slate-300 p-2 text-xs outline-none ring-amber-300 transition focus:ring-2"
          />

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
                    <th className="px-3 py-2">통과 케이스</th>
                  </tr>
                </thead>
                <tbody>
                  {batchResult.submissions.map((item) => {
                    const passedCaseCount = item.passedCaseCount ?? item.results.filter((result) => result.passed).length;
                    const accepted = item.accepted ?? item.score > 0;
                    const displayFilename = repairFilenameMojibake(item.filename);

                    return (
                      <tr key={item.id} className="border-b border-slate-100">
                        <td className="px-3 py-2">
                          <Link href={`/submissions/${item.id}`} className="text-blue-700 underline-offset-2 hover:underline">
                            {displayFilename}
                          </Link>
                        </td>
                        <td className="px-3 py-2 font-semibold">
                          {item.score} / {item.maxScore}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`rounded-full px-2 py-1 text-xs font-semibold ${
                              accepted ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-700"
                            }`}
                          >
                            {accepted ? "정답 처리" : "0점 처리"}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          {passedCaseCount} / {batchResult.testCaseCount}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
