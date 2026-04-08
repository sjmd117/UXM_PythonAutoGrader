"use client";

export type TestCase = {
  input: string;
  expectedOutput: string;
  weight: number | "";
};

type Props = {
  testCases: TestCase[];
  onAddCase: () => void;
  onRemoveCase: (index: number) => void;
  onUpdateCase: (index: number, patch: Partial<TestCase>) => void;
  listClassName?: string;
};

export default function TestCaseEditor({
  testCases,
  onAddCase,
  onRemoveCase,
  onUpdateCase,
  listClassName = "max-h-[355px] space-y-3 overflow-y-auto pr-1",
}: Props) {
  return (
    <>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">테스트 케이스</h2>
        <button
          type="button"
          onClick={onAddCase}
          className="rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white transition hover:bg-slate-700"
        >
          + 추가
        </button>
      </div>

      <div className={listClassName}>
        {testCases.map((testCase, index) => (
          <article key={index} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <strong className="text-xs text-slate-700">Case #{index + 1}</strong>
              <button
                type="button"
                onClick={() => onRemoveCase(index)}
                disabled={testCases.length === 1}
                className="text-xs text-rose-600 disabled:cursor-not-allowed disabled:text-slate-300"
              >
                삭제
              </button>
            </div>
            <textarea
              value={testCase.input}
              onChange={(e) => onUpdateCase(index, { input: e.target.value })}
              placeholder="입력값"
              className="mb-2 h-20 w-full resize-none rounded-xl border border-slate-200 p-2 text-xs outline-none ring-amber-300 transition focus:ring-2"
            />
            <textarea
              value={testCase.expectedOutput}
              onChange={(e) => onUpdateCase(index, { expectedOutput: e.target.value })}
              placeholder="기대 출력값"
              className="mb-2 h-20 w-full resize-none rounded-xl border border-slate-200 p-2 text-xs outline-none ring-amber-300 transition focus:ring-2"
            />
            <input
              type="number"
              min={0}
              step={1}
              value={testCase.weight}
              onChange={(e) => onUpdateCase(index, { weight: e.target.value === "" ? "" : Number(e.target.value) })}
              className="w-full rounded-xl border border-slate-200 p-2 text-xs outline-none ring-amber-300 transition focus:ring-2"
              placeholder="배점"
            />
          </article>
        ))}
      </div>
    </>
  );
}
