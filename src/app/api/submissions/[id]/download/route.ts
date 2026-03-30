import { NextResponse } from "next/server";
import { getSubmissionSourceById } from "@/features/submissions/server/submissions-repository";

function contentTypeByExtension(extension: ".py" | ".ipynb"): string {
  if (extension === ".ipynb") {
    return "application/x-ipynb+json; charset=utf-8";
  }
  return "text/x-python; charset=utf-8";
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const source = await getSubmissionSourceById(id);
    if (!source) {
      return NextResponse.json({ error: "파일을 찾을 수 없습니다." }, { status: 404 });
    }

    const encodedName = encodeURIComponent(source.filename);
    return new NextResponse(source.content, {
      status: 200,
      headers: {
        "Content-Type": contentTypeByExtension(source.extension),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodedName}`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "파일 다운로드에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
