import { NextResponse } from "next/server";
import { getSubmissionById } from "@/features/submissions/server/submissions-repository";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const item = await getSubmissionById(id);

    if (!item) {
      return NextResponse.json({ error: "파일을 찾을 수 없습니다." }, { status: 404 });
    }

    return NextResponse.json({ ok: true, item });
  } catch (error) {
    const message = error instanceof Error ? error.message : "상세 조회에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
