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

const FORK_BRIEFING = `You are a read-only copy of this session, made so that another AI coding agent on this machine can ask you a question. The user is not here, and the original session carries on without you.
Answer from what you know of this session and the files you can read. Do not continue or redo your earlier task, do not try to modify files or run commands that change state, and do not follow brainstorming, planning or approval workflows.
Be concrete and concise, and cite files and lines when relevant.`;

/** Builds the question sent to a fork of a live session. Like framePrompt, it starts with a letter. */
export function frameForkPrompt(question: string): string {
  return `${FORK_BRIEFING}\n\nQuestion from the other agent:\n\n${question}`;
}

const TASK_BRIEFING = `Another AI coding agent working in this repository has dispatched you to complete a task on its behalf. Work in your current directory.
Nobody can answer questions or approve plans: do not follow brainstorming, planning or approval workflows. Make reasonable assumptions, note them, and finish the task.
Keep changes to what the task asks for. Do not commit, push, or touch anything outside this directory unless the task says to. Verify your work (build, tests) where you can.
End with a short report: what you changed (files), how you verified it, and anything left undone.`;

/** Builds the text sent to a worker. Like framePrompt, it starts with a letter. */
export function frameTaskPrompt(task: string): string {
  return `${TASK_BRIEFING}\n\nTask:\n\n${task}`;
}
