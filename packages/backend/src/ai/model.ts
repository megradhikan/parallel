// Single place to change the model string for both AI features.
// Verify against docs.claude.com before a demo — model aliases move.
export const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
