"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";
import TestCaseEditor, { type TestCase } from "@/features/grading/components/TestCaseEditor";

type GradeResult = {
  index: number;
  passed: boolean;
  scoreEarned: number;
  scoreTotal: number;
  actualOutput: string;
  expectedOutput: string;
  error?: string;
  runtimeMs: number;
  status: "passed" | "failed" | "runtime_error" | "timeout";
};

type GradeResponse = {
  ok: boolean;
  summary: {
    totalScore: number;
    maxScore: number;
    passedCount: number;
    totalCount: number;
  };
  results: GradeResult[];
  pythonCommand: string;
};

type Props = {
  submissionId: string;
  filename: string;
  initialCode: string;
};

const DEFAULT_CASES: TestCase[] = [{ input: "", expectedOutput: "", weight: "" }];

export default function GraderWorkspace({ submissionId, filename, initialCode }: Props) {
  const [code] = useState(initialCode);
  const [testCases, setTestCases] = useState(DEFAULT_CASES);
  const [timeoutMs, setTimeoutMs] = useState(2000);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GradeResponse | null>(null);

  const maxScore = useMemo(
    () => testCases.reduce((acc, tc) => acc + (typeof tc.weight === "number" ? tc.weight : 0), 0),
    [testCases],
  );

  const updateCase = (index: number, patch: Partial<TestCase>) => {
    setTestCases((prev) => prev.map((tc, i) => (i === index ? { ...tc, ...patch } : tc)));
  };

  const addCase = () => {
    setTestCases((prev) => [...prev, { input: "", expectedOutput: "", weight: "" }]);
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
            <p className="mt-1 text-sm text-slate-600">파일: {filename}</p>
          </div>
          <Link href="/" className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
            파일 목록으로
          </Link>
        </div>

        <p className="mt-3 text-xs text-slate-500">Submission ID: {submissionId}</p>

        <form className="mt-6 grid gap-6 lg:grid-cols-[1.2fr_1fr]" onSubmit={onSubmit}>
          <section className="space-y-3">
            <label className="text-sm font-semibold text-slate-700" htmlFor="python-code">
              Python 코드
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
              점수 {result.summary.totalScore} / {result.summary.maxScore} · 통과 {result.summary.passedCount} / {result.summary.totalCount} · 실행기: {result.pythonCommand}
            </p>

            <div className="mt-4 space-y-2">
              {result.results.map((item) => (
                <article
                  key={item.index}
                  className={`rounded-xl border p-3 text-sm ${item.passed ? "border-emerald-300 bg-emerald-50" : "border-rose-300 bg-rose-50"}`}
                >
                  <p className="font-semibold">
                    Case #{item.index + 1} · {item.scoreEarned}/{item.scoreTotal}점 · {item.status} · {item.runtimeMs}ms
                  </p>
                  {!item.passed && (
                    <>
                      <p className="mt-1 whitespace-pre-wrap">expected: {item.expectedOutput || "(빈 값)"}</p>
                      <p className="mt-1 whitespace-pre-wrap">actual: {item.actualOutput || "(빈 값)"}</p>
                    </>
                  )}
                  {item.error && <p className="mt-1 whitespace-pre-wrap text-rose-700">error: {item.error}</p>}
                </article>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
