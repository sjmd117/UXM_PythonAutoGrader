import { NextResponse } from "next/server";
import {
  boundedTimeout,
  MAX_CODE_SIZE,
  runPythonCode,
} from "@/features/grading/server/python-grading-engine";

type RunRequest = {
  code: string;
  stdin?: string;
  timeoutMs?: number;
  forbiddenMethods?: string[];
};

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as RunRequest;

    if (typeof payload.code !== "string" || payload.code.trim().length === 0) {
      return NextResponse.json({ error: "실행할 코드를 입력해주세요." }, { status: 400 });
    }

    if (payload.code.length > MAX_CODE_SIZE) {
      return NextResponse.json({ error: "코드 길이가 너무 깁니다." }, { status: 400 });
    }

    const result = await runPythonCode({
      code: payload.code,
      stdin: typeof payload.stdin === "string" ? payload.stdin : "",
      timeoutMs: boundedTimeout(payload.timeoutMs),
      forbiddenMethods: payload.forbiddenMethods,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "코드 실행 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
