import { NextResponse } from "next/server";
import { getProjectById } from "@/features/projects/server/projects-repository";
import { getSubmissionById } from "@/features/submissions/server/submissions-repository";

type Context = {
  params: Promise<{ projectId: string; id: string }>;
};

export async function GET(_request: Request, context: Context) {
  try {
    const { projectId, id } = await context.params;
    const project = await getProjectById(projectId);
    if (!project) {
      return NextResponse.json({ error: "과제를 찾을 수 없습니다." }, { status: 404 });
    }

    const item = await getSubmissionById(id, projectId);
    if (!item) {
      return NextResponse.json({ error: "파일을 찾을 수 없습니다." }, { status: 404 });
    }

    return NextResponse.json({ ok: true, item });
  } catch (error) {
    const message = error instanceof Error ? error.message : "상세 조회에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
