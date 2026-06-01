import { NextResponse } from "next/server";
import { getProjectById } from "@/features/projects/server/projects-repository";
import {
  boundedTimeout,
  gradeCodeAgainstCases,
  MAX_TEST_CASES,
  type IncomingTestCase,
} from "@/features/grading/server/python-grading-engine";
import { listSubmissionDetails } from "@/features/submissions/server/submissions-repository";
import { repairFilenameMojibake } from "@/lib/repair-filename";

type Context = {
  params: Promise<{ projectId: string }>;
};

type BatchGradeRequest = {
  testCases: IncomingTestCase[];
  timeoutMs?: number;
  forbiddenMethods?: string[];
};

export async function POST(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const project = await getProjectById(projectId);
    if (!project) {
      return NextResponse.json({ error: "과제를 찾을 수 없습니다." }, { status: 404 });
    }

    const payload = (await request.json()) as BatchGradeRequest;

    if (!Array.isArray(payload.testCases) || payload.testCases.length === 0) {
      return NextResponse.json({ error: "최소 1개 이상의 테스트케이스가 필요합니다." }, { status: 400 });
    }

    if (payload.testCases.length > MAX_TEST_CASES) {
      return NextResponse.json({ error: `테스트케이스는 최대 ${MAX_TEST_CASES}개까지 가능합니다.` }, { status: 400 });
    }

    const submissions = await listSubmissionDetails(projectId);
    if (submissions.length === 0) {
      return NextResponse.json({ error: "업로드된 파일이 없습니다." }, { status: 400 });
    }

    const timeoutMs = boundedTimeout(payload.timeoutMs);
    const gradedItems = [];
    let pythonCommand = "";

    for (const submission of submissions) {
      const graded = await gradeCodeAgainstCases({
        code: submission.code,
        testCases: payload.testCases,
        timeoutMs,
        forbiddenMethods: payload.forbiddenMethods,
        scorePolicy: "any",
      });

      pythonCommand = graded.pythonCommand;
      gradedItems.push({
        id: submission.id,
        filename: repairFilenameMojibake(submission.filename),
        extension: submission.extension,
        score: graded.summary.totalScore,
        maxScore: graded.summary.maxScore,
        accepted: graded.summary.accepted,
        allPassed: graded.summary.allPassed,
        passedCaseCount: graded.summary.passedCount,
        failedCaseCount: graded.summary.totalCount - graded.summary.passedCount,
        results: graded.results,
      });
    }

    return NextResponse.json({
      ok: true,
      pythonCommand,
      testCaseCount: payload.testCases.length,
      submissions: gradedItems,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "일괄 채점 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
