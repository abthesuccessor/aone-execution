type ResultKind = "error" | "data-error" | "empty-search" | "empty-saved" | "end";

interface ResultStateProps {
  readonly kind: ResultKind;
  readonly onAction?: () => void;
}

const copy = {
  error: ["A small interruption", "The next collection could not be opened.", "Try again"],
  "data-error": ["The collection is unavailable", "The bundled gallery data could not be validated.", ""],
  "empty-search": ["Nothing in this frame", "Try another title, creator, or category.", "Clear filters"],
  "empty-saved": ["Your collection starts here", "Save work that you want to return to.", "Explore work"],
  end: ["You’ve reached the edge", "All work in this collection is now in view.", ""]
} as const;

export function ResultState({ kind, onAction }: ResultStateProps) {
  const [title, description, action] = copy[kind];
  return <section className={`result-state ${kind}`} role={kind === "error" || kind === "data-error" ? "alert" : "status"}><span>Frame / {kind.replace("-", " ")}</span><h2>{title}</h2><p>{description}</p>{action && onAction && <button onClick={onAction}>{action}</button>}</section>;
}
