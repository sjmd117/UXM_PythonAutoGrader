import { NextResponse } from "next/server";
import { deleteProjectById, getProjectById } from "@/features/projects/server/projects-repository";

type Context = {
  params: Promise<{ projectId: string }>;
};

export async function GET(_request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const project = await getProjectById(projectId);
    if (!project) {
      return NextResponse.json({ error: "과제를 찾을 수 없습니다." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, project });
  } catch (error) {
    const message = error instanceof Error ? error.message : "과제 조회에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    const result = await deleteProjectById(projectId);
    if (!result.deleted) {
      return NextResponse.json({ error: "과제를 찾을 수 없습니다." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "과제 삭제에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
