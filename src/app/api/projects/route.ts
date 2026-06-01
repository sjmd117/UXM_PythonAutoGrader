import { NextResponse } from "next/server";
import { createProject, listProjects } from "@/features/projects/server/projects-repository";

type CreateProjectRequest = {
  name?: string;
  description?: string;
};

export async function GET() {
  try {
    const items = await listProjects();
    return NextResponse.json({ ok: true, items });
  } catch (error) {
    const message = error instanceof Error ? error.message : "과제 목록 조회에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as CreateProjectRequest;
    const project = await createProject({
      name: payload.name ?? "",
      description: payload.description,
    });
    return NextResponse.json({ ok: true, project }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "과제 생성에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
