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
  status: "passed" | "failed" | "runtime_error" | "timeout" | "forbidden_method";
};

export type ForbiddenMethodViolation = {
  rule: string;
  call: string;
  line: number;
  column: number;
};

export type CodeRunResult = {
  pythonCommand: string;
  stdout: string;
  stderr: string;
  status: "ok" | "runtime_error" | "timeout" | "forbidden_method";
  runtimeMs: number;
};

type ScorePolicy = "partial" | "all" | "any";

export const MAX_CODE_SIZE = 50_000;
export const MAX_TEST_CASES = 30;
export const MAX_FORBIDDEN_METHODS = 50;
export const MAX_FORBIDDEN_METHOD_LENGTH = 80;
export const DEFAULT_TIMEOUT_MS = 2_000;
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 20_000;
const STATIC_ANALYSIS_TIMEOUT_MS = 3_000;

const FORBIDDEN_METHOD_SCAN_SCRIPT = String.raw`
import ast
import json
import sys

rules = [str(item).strip() for item in json.loads(sys.argv[1]) if str(item).strip()]
rule_lookup = {rule.lower(): rule for rule in rules}
code = sys.stdin.read()

def attr_chain(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    if not parts:
        return ""
    return ".".join(reversed(parts))

def call_names(func):
    if isinstance(func, ast.Name):
        return [func.id]
    if isinstance(func, ast.Attribute):
        chain = attr_chain(func)
        names = [func.attr]
        if chain:
            names.append(chain)
        return names
    return []

def matches(rule, names):
    normalized_rule = rule.lower()
    for name in names:
        normalized_name = name.lower()
        if normalized_name == normalized_rule or normalized_name.endswith("." + normalized_rule):
            return True
    return False

try:
    tree = ast.parse(code)
except SyntaxError as exc:
    print(json.dumps({"ok": True, "violations": [], "parseError": str(exc)}, ensure_ascii=False))
    sys.exit(0)

violations = []
seen = set()
for node in ast.walk(tree):
    if not isinstance(node, ast.Call):
        continue
    names = call_names(node.func)
    if not names:
        continue
    display_name = max(names, key=len)
    for normalized_rule, original_rule in rule_lookup.items():
        if not matches(normalized_rule, names):
            continue
        key = (original_rule, display_name, getattr(node, "lineno", 0), getattr(node, "col_offset", 0))
        if key in seen:
            continue
        seen.add(key)
        violations.append({
            "rule": original_rule,
            "call": display_name,
            "line": getattr(node, "lineno", 0),
            "column": getattr(node, "col_offset", 0) + 1,
        })

print(json.dumps({"ok": True, "violations": violations}, ensure_ascii=False))
`;

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

export function normalizeForbiddenMethods(value?: string[]): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const normalized = item.trim();
    if (!normalized || normalized.length > MAX_FORBIDDEN_METHOD_LENGTH) {
      continue;
    }
    unique.add(normalized);
    if (unique.size >= MAX_FORBIDDEN_METHODS) {
      break;
    }
  }

  return [...unique];
}

function formatForbiddenMethodError(violations: ForbiddenMethodViolation[]): string {
  const preview = violations
    .slice(0, 5)
    .map((item) => `${item.rule} 사용 감지 (${item.line}:${item.column}, 호출: ${item.call})`)
    .join("\n");

  const suffix = violations.length > 5 ? `\n외 ${violations.length - 5}건` : "";
  return `금지 메소드가 사용되어 채점하지 않았습니다.\n${preview}${suffix}`;
}

async function scanForbiddenMethods(params: {
  pythonCommand: string;
  code: string;
  forbiddenMethods: string[];
}): Promise<ForbiddenMethodViolation[]> {
  if (params.forbiddenMethods.length === 0) {
    return [];
  }

  const execution = await spawnAndCollect(
    params.pythonCommand,
    ["-I", "-c", FORBIDDEN_METHOD_SCAN_SCRIPT, JSON.stringify(params.forbiddenMethods)],
    params.code,
    STATIC_ANALYSIS_TIMEOUT_MS,
  );

  if (execution.status !== "ok") {
    return [];
  }

  try {
    const payload = JSON.parse(execution.stdout) as { violations?: ForbiddenMethodViolation[] };
    return Array.isArray(payload.violations) ? payload.violations : [];
  } catch {
    return [];
  }
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

export async function runPythonCode(params: {
  code: string;
  stdin?: string;
  timeoutMs: number;
  forbiddenMethods?: string[];
}): Promise<CodeRunResult> {
  const { code, timeoutMs } = params;
  const pythonCommand = await detectPythonCommand();
  const forbiddenMethods = normalizeForbiddenMethods(params.forbiddenMethods);
  const forbiddenViolations = await scanForbiddenMethods({
    pythonCommand,
    code,
    forbiddenMethods,
  });

  if (forbiddenViolations.length > 0) {
    return {
      pythonCommand,
      stdout: "",
      stderr: formatForbiddenMethodError(forbiddenViolations),
      status: "forbidden_method",
      runtimeMs: 0,
    };
  }

  const prompts = extractInputPrompts(code);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "uxm-grader-run-"));
  const scriptPath = path.join(tempDir, "student.py");

  try {
    await fs.writeFile(scriptPath, code, "utf8");
    const execution = await spawnAndCollect(
      pythonCommand,
      ["-I", scriptPath],
      typeof params.stdin === "string" ? params.stdin : "",
      timeoutMs,
      tempDir,
    );

    return {
      pythonCommand,
      stdout: normalizeOutput(stripInputPrompts(execution.stdout, prompts)),
      stderr: execution.stderr.trim(),
      status: execution.status,
      runtimeMs: execution.runtimeMs,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function gradeCodeAgainstCases(params: {
  code: string;
  testCases: IncomingTestCase[];
  timeoutMs: number;
  forbiddenMethods?: string[];
  scorePolicy?: ScorePolicy;
  allOrNothing?: boolean;
}) {
  const { code, testCases, timeoutMs, allOrNothing = false } = params;
  const scorePolicy = params.scorePolicy ?? (allOrNothing ? "all" : "partial");
  const forbiddenMethods = normalizeForbiddenMethods(params.forbiddenMethods);
  const prompts = extractInputPrompts(code);
  const pythonCommand = await detectPythonCommand();

  const forbiddenViolations = await scanForbiddenMethods({
    pythonCommand,
    code,
    forbiddenMethods,
  });

  if (forbiddenViolations.length > 0) {
    const error = formatForbiddenMethodError(forbiddenViolations);
    const results = testCases.map((testCase, index): GradeCaseResult => {
      const scoreTotal = parseWeight(testCase.weight);
      return {
        index,
        passed: false,
        scoreEarned: 0,
        scoreTotal,
        expectedOutput: normalizeOutput(typeof testCase.expectedOutput === "string" ? testCase.expectedOutput : ""),
        actualOutput: "",
        error,
        runtimeMs: 0,
        status: "forbidden_method",
      };
    });
    const weightedTotal = results.reduce((acc, item) => acc + item.scoreTotal, 0);

    return {
      pythonCommand,
      results,
      summary: {
        totalScore: 0,
        maxScore: weightedTotal,
        passedCount: 0,
        totalCount: testCases.length,
        allPassed: false,
        accepted: false,
      },
    };
  }

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
  const anyPassed = passedCount > 0;
  const accepted =
    scorePolicy === "all" ? allPassed : scorePolicy === "any" ? anyPassed : anyPassed;
  const totalScore =
    scorePolicy === "all"
      ? allPassed
        ? weightedTotal
        : 0
      : scorePolicy === "any"
        ? anyPassed
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
      accepted,
    },
  };
}
