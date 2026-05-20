import { NextResponse } from "next/server";
import {
  boundedTimeout,
  gradeCodeAgainstCases,
  MAX_CODE_SIZE,
  MAX_TEST_CASES,
  type IncomingTestCase,
} from "@/features/grading/server/python-grading-engine";

type GradeRequest = {
  code: string;
  testCases: IncomingTestCase[];
  timeoutMs?: number;
  forbiddenMethods?: string[];
};

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as GradeRequest;

    if (typeof payload.code !== "string" || payload.code.trim().length === 0) {
      return NextResponse.json({ error: "코드를 입력해주세요." }, { status: 400 });
    }

    if (payload.code.length > MAX_CODE_SIZE) {
      return NextResponse.json({ error: "코드 길이가 너무 깁니다." }, { status: 400 });
    }

    if (!Array.isArray(payload.testCases) || payload.testCases.length === 0) {
      return NextResponse.json({ error: "최소 1개 이상의 테스트케이스가 필요합니다." }, { status: 400 });
    }

    if (payload.testCases.length > MAX_TEST_CASES) {
      return NextResponse.json({ error: `테스트케이스는 최대 ${MAX_TEST_CASES}개까지 가능합니다.` }, { status: 400 });
    }

    const timeoutMs = boundedTimeout(payload.timeoutMs);
    const graded = await gradeCodeAgainstCases({
      code: payload.code,
      testCases: payload.testCases,
      timeoutMs,
      forbiddenMethods: payload.forbiddenMethods,
      scorePolicy: "any",
    });

    return NextResponse.json({
      ok: true,
      pythonCommand: graded.pythonCommand,
      summary: graded.summary,
      results: graded.results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "채점 서버 처리 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
