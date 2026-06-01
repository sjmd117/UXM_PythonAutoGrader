import { NextResponse } from "next/server";
import { createSubmissionsFromUpload, deleteSubmissionsByIds, listSubmissions } from "@/features/submissions/server/submissions-repository";
import { getProjectById } from "@/features/projects/server/projects-repository";

type Context = {
  params: Promise<{ projectId: string }>;
};

async function requireProject(projectId: string) {
  const project = await getProjectById(projectId);
  if (!project) {
    throw new Error("과제를 찾을 수 없습니다.");
  }
  return project;
}

export async function GET(_request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    await requireProject(projectId);
    const items = await listSubmissions(projectId);
    return NextResponse.json({ ok: true, items });
  } catch (error) {
    const message = error instanceof Error ? error.message : "목록 조회에 실패했습니다.";
    const status = message === "과제를 찾을 수 없습니다." ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    await requireProject(projectId);
    const form = await request.formData();
    const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);

    if (files.length === 0) {
      return NextResponse.json({ error: "업로드할 파일을 선택해주세요." }, { status: 400 });
    }

    const created = [];
    const skipped = [];
    for (const file of files) {
      const result = await createSubmissionsFromUpload(file, projectId);
      created.push(...result.created);
      skipped.push(...result.skipped);
    }

    return NextResponse.json({ ok: true, created, skipped }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "파일 업로드에 실패했습니다.";
    const status = message === "과제를 찾을 수 없습니다." ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

type DeletePayload = {
  ids: string[];
};

export async function DELETE(request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    await requireProject(projectId);
    const payload = (await request.json()) as DeletePayload;
    if (!Array.isArray(payload.ids) || payload.ids.length === 0) {
      return NextResponse.json({ error: "삭제할 파일을 선택해주세요." }, { status: 400 });
    }

    const ids = payload.ids.filter((id): id is string => typeof id === "string" && id.length > 0);
    const result = await deleteSubmissionsByIds(ids, projectId);
    return NextResponse.json({ ok: true, deletedCount: result.deletedCount });
  } catch (error) {
    const message = error instanceof Error ? error.message : "파일 삭제에 실패했습니다.";
    const status = message === "과제를 찾을 수 없습니다." ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
