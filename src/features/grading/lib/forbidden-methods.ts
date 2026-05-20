export function parseForbiddenMethodsInput(value: string): string[] {
  const unique = new Set<string>();
  for (const token of value.split(/[\n,]+/u)) {
    const normalized = token.trim();
    if (normalized) {
      unique.add(normalized);
    }
  }
  return [...unique];
}

export function formatGradeStatus(status: string): string {
  switch (status) {
    case "passed":
      return "통과";
    case "failed":
      return "실패";
    case "runtime_error":
      return "실행 오류";
    case "timeout":
      return "시간 초과";
    case "forbidden_method":
      return "금지 메소드";
    default:
      return status;
  }
}
