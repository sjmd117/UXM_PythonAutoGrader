import { notFound } from "next/navigation";
import { getProjectById } from "@/features/projects/server/projects-repository";
import SubmissionUploadList from "@/features/submissions/components/SubmissionUploadList";

type Props = {
  params: Promise<{ projectId: string }>;
};

export default async function ProjectWorkspacePage({ params }: Props) {
  const { projectId } = await params;
  const project = await getProjectById(projectId);

  if (!project) {
    notFound();
  }

  return <SubmissionUploadList projectId={project.id} projectName={project.name} />;
}
