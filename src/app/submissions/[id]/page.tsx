import { notFound } from "next/navigation";
import GraderWorkspace from "@/features/grading/components/GraderWorkspace";
import { getSubmissionById } from "@/features/submissions/server/submissions-repository";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function SubmissionDetailPage({ params }: Props) {
  const { id } = await params;
  const item = await getSubmissionById(id);

  if (!item) {
    notFound();
  }

  return <GraderWorkspace submissionId={item.id} filename={item.filename} initialCode={item.code} />;
}
