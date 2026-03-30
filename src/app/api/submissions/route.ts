import { NextResponse } from "next/server";
import { createSubmissionFromFile, deleteSubmissionsByIds, listSubmissions } from "@/features/submissions/server/submissions-repository";

export async function GET() {
  try {
    const items = await listSubmissions();
    return NextResponse.json({ ok: true, items });
  } catch (error) {
    const message = error instanceof Error ? error.message : "목록 조회에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);

    if (files.length === 0) {
      return NextResponse.json({ error: "업로드할 파일을 선택해주세요." }, { status: 400 });
    }

    const created = [];
    for (const file of files) {
      const item = await createSubmissionFromFile(file);
      created.push(item);
    }

    return NextResponse.json({ ok: true, created }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "파일 업로드에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

type DeletePayload = {
  ids: string[];
};

export async function DELETE(request: Request) {
  try {
    const payload = (await request.json()) as DeletePayload;
    if (!Array.isArray(payload.ids) || payload.ids.length === 0) {
      return NextResponse.json({ error: "삭제할 파일을 선택해주세요." }, { status: 400 });
    }

    const ids = payload.ids.filter((id): id is string => typeof id === "string" && id.length > 0);
    const result = await deleteSubmissionsByIds(ids);
    return NextResponse.json({ ok: true, deletedCount: result.deletedCount });
  } catch (error) {
    const message = error instanceof Error ? error.message : "파일 삭제에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
