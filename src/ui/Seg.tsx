import type { HTMLAttributes, ReactNode } from "react";

/** Segmented control strip. Styling container only — children are plain
 *  <button> elements carrying their own semantics (aria-pressed for toggles,
 *  aria-selected for tabs, .is-current for ladders); ui.css styles the states
 *  uniformly. Variants: "strike" crosses out unpressed toggles instead of
 *  ink-filling pressed ones. */
function Seg({
  variant,
  plate = false,
  className,
  children,
  ...rest
}: {
  variant?: "strike";
  plate?: boolean;
  className?: string;
  children: ReactNode;
} & HTMLAttributes<HTMLDivElement>) {
  const classes = [
    "seg",
    variant === "strike" ? "seg--strike" : "",
    plate ? "plate" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  );
}

export default Seg;
