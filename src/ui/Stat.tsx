import type { ReactNode } from "react";

/** Micro-label over a value: instrument-bar readings, inspector signal cells. */
function Stat({
  label,
  value,
  title,
  className,
}: {
  label: string;
  value: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <div className={className ? `stat ${className}` : "stat"}>
      <span>{label}</span>
      <strong title={title}>{value}</strong>
    </div>
  );
}

export default Stat;
