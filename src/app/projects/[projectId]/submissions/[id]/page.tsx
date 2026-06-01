import { notFound } from "next/navigation";
import GraderWorkspace from "@/features/grading/components/GraderWorkspace";
import { getProjectById } from "@/features/projects/server/projects-repository";
import { getSubmissionById } from "@/features/submissions/server/submissions-repository";

type Props = {
  params: Promise<{ projectId: string; id: string }>;
};

export default async function ProjectSubmissionDetailPage({ params }: Props) {
  const { projectId, id } = await params;
  const project = await getProjectById(projectId);

  if (!project) {
    notFound();
  }

  const item = await getSubmissionById(id, projectId);

  if (!item) {
    notFound();
  }

  return (
    <GraderWorkspace
      projectId={project.id}
      projectName={project.name}
      submissionId={item.id}
      filename={item.filename}
      initialCode={item.code}
      notebookCells={item.notebookCells}
    />
  );
}
