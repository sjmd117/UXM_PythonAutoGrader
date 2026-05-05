import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

export type IncomingTestCase = {
  input: string;
  expectedOutput: string;
  weight?: number;
};

export type GradeCaseResult = {
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

export const MAX_CODE_SIZE = 50_000;
export const MAX_TEST_CASES = 30;
export const DEFAULT_TIMEOUT_MS = 2_000;
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 20_000;

let cachedPythonCommand: string | null = null;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractInputPrompts(code: string): string[] {
  const prompts: string[] = [];
  const doubleQuoted = /input\s*\(\s*(?:[rRuUbBfF]{0,2})?"((?:\\.|[^"\\])*)"\s*\)/g;
  const singleQuoted = /input\s*\(\s*(?:[rRuUbBfF]{0,2})?'((?:\\.|[^'\\])*)'\s*\)/g;

  const collect = (regex: RegExp) => {
    let match = regex.exec(code);
    while (match) {
      const raw = match[1] ?? "";
      const unescaped = raw
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\r/g, "\r")
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, "\\");

      if (unescaped.length > 0) {
        prompts.push(unescaped);
      }
      match = regex.exec(code);
    }
  };

  collect(doubleQuoted);
  collect(singleQuoted);
  return prompts;
}

function stripInputPrompts(stdout: string, prompts: string[]): string {
  let cleaned = stdout;
  for (const prompt of prompts) {
    if (!prompt) {
      continue;
    }
    cleaned = cleaned.replace(new RegExp(escapeRegExp(prompt), "g"), "");
  }
  return cleaned;
}

function normalizeOutput(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function normalizeFlexibleWhitespace(text: string): string {
  return normalizeOutput(text).replace(/\s+/g, " ").trim();
}

function extractTokens(text: string): string[] {
  return normalizeFlexibleWhitespace(text)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

function extractNumbers(text: string): number[] {
  const matches = normalizeOutput(text).match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  return matches.map(Number).filter(Number.isFinite);
}

function numbersAreEqual(expected: number[], actual: number[]): boolean {
  if (expected.length === 0 || expected.length !== actual.length) {
    return false;
  }

  return expected.every((value, index) => Math.abs(value - actual[index]) <= 1e-9);
}

function tokenSubsetMatches(expected: string, actual: string): boolean {
  const tokens = extractTokens(expected);
  const normalizedActual = normalizeFlexibleWhitespace(actual);
  return tokens.length > 0 && tokens.every((token) => normalizedActual.includes(token));
}

function numberSequenceMatches(expected: string, actual: string): boolean {
  return numbersAreEqual(extractNumbers(expected), extractNumbers(actual));
}

function compareOutputLeniently(expected: string, actual: string): boolean {
  return (
    normalizeFlexibleWhitespace(actual) === normalizeFlexibleWhitespace(expected) ||
    tokenSubsetMatches(expected, actual) ||
    numberSequenceMatches(expected, actual)
  );
}

function parseWeight(weight?: number): number {
  if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
    return 1;
  }
  return Math.floor(weight);
}

export function boundedTimeout(timeoutMs?: number): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(timeoutMs)));
}

function spawnAndCollect(command: string, args: string[], stdinText: string, timeoutMs: number, cwd?: string) {
  return new Promise<{
    stdout: string;
    stderr: string;
    status: "ok" | "runtime_error" | "timeout";
    runtimeMs: number;
  }>((resolve, reject) => {
    const start = Date.now();
    const child = spawn(command, args, {
      cwd,
      stdio: "pipe",
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });

    const killTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      resolve({
        stdout,
        stderr: `${stderr}\nExecution timed out (${timeoutMs}ms).`.trim(),
        status: "timeout",
        runtimeMs: Date.now() - start,
      });
    }, timeoutMs);

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(killTimer);
      resolve({
        stdout,
        stderr,
        status: code === 0 ? "ok" : "runtime_error",
        runtimeMs: Date.now() - start,
      });
    });

    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

export async function detectPythonCommand(): Promise<string> {
  if (cachedPythonCommand) {
    return cachedPythonCommand;
  }

  const candidates = ["python", "python3", "py"];
  for (const cmd of candidates) {
    try {
      const probe = await spawnAndCollect(cmd, ["--version"], "", 3_000);
      if (probe.status === "ok") {
        cachedPythonCommand = cmd;
        return cmd;
      }
    } catch {
      continue;
    }
  }

  throw new Error("Python 실행기를 찾지 못했습니다. python 또는 python3를 설치해주세요.");
}

export async function gradeCodeAgainstCases(params: {
  code: string;
  testCases: IncomingTestCase[];
  timeoutMs: number;
  allOrNothing?: boolean;
}) {
  const { code, testCases, timeoutMs, allOrNothing = false } = params;
  const prompts = extractInputPrompts(code);
  const pythonCommand = await detectPythonCommand();

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "uxm-grader-"));
  const scriptPath = path.join(tempDir, "student.py");
  await fs.writeFile(scriptPath, code, "utf8");

  const results: GradeCaseResult[] = [];
  let weightedTotal = 0;
  let passedCount = 0;

  try {
    for (let i = 0; i < testCases.length; i += 1) {
      const testCase = testCases[i];
      const scoreTotal = parseWeight(testCase.weight);
      weightedTotal += scoreTotal;

      const execution = await spawnAndCollect(
        pythonCommand,
        ["-I", scriptPath],
        typeof testCase.input === "string" ? testCase.input : "",
        timeoutMs,
        tempDir,
      );

      const expected = normalizeOutput(typeof testCase.expectedOutput === "string" ? testCase.expectedOutput : "");
      const actual = normalizeOutput(stripInputPrompts(execution.stdout, prompts));

      const passed = execution.status === "ok" && compareOutputLeniently(expected, actual);
      if (passed) {
        passedCount += 1;
      }

      const scoreEarned = passed ? scoreTotal : 0;
      results.push({
        index: i,
        passed,
        scoreEarned,
        scoreTotal,
        expectedOutput: expected,
        actualOutput: actual,
        error: execution.status !== "ok" ? execution.stderr.trim() : undefined,
        runtimeMs: execution.runtimeMs,
        status: passed
          ? "passed"
          : execution.status === "timeout"
            ? "timeout"
            : execution.status === "runtime_error"
              ? "runtime_error"
              : "failed",
      });
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  const allPassed = passedCount === testCases.length;
  const totalScore = allOrNothing
    ? allPassed
      ? weightedTotal
      : 0
    : results.reduce((acc, item) => acc + item.scoreEarned, 0);

  return {
    pythonCommand,
    results,
    summary: {
      totalScore,
      maxScore: weightedTotal,
      passedCount,
      totalCount: testCases.length,
      allPassed,
    },
  };
}
