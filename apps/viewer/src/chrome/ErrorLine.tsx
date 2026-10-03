import type { AppError } from "../api/client";

export function ErrorLine({ error }: { error: AppError }) {
  return (
    <p role="alert" className="error">
      <span className="error-kind">{error.kind}</span> {error.message}
    </p>
  );
}
