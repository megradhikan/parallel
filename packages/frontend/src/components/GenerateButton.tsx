interface GenerateButtonProps {
  onClick: () => void;
  isStreaming: boolean;
}

export function GenerateButton({ onClick, isStreaming }: GenerateButtonProps) {
  return (
    <button className="generate-btn" onClick={onClick} disabled={isStreaming}>
      {isStreaming ? "Generating…" : "Generate code here (⌘J)"}
    </button>
  );
}
