const BRIEFING = `You are being consulted as an advisor by another AI coding agent working in this repository.
You have read-only access to the files in your working directory: read whatever helps, but do not try to modify anything or run commands that change state.
You cannot ask clarifying questions and nobody will approve plans: do not follow brainstorming, planning or approval workflows. State any assumptions and answer directly.
Give your honest, concrete advice. Disagree with the premise if it is wrong, point out risks the asker may have missed, and cite files and lines when relevant. Keep it concise.`;

/**
 * Builds the text sent to the advisor. Both forms start with a letter, so a question that begins
 * with "-" is never taken for a CLI flag.
 */
export function framePrompt(question: string, isFollowUp: boolean): string {
  return isFollowUp
    ? `Follow-up from the consulting agent:\n\n${question}`
    : `${BRIEFING}\n\nQuestion from the consulting agent:\n\n${question}`;
}
