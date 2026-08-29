import type { ReactNode } from "react";

/** Panel heading: micro-index over an uppercase title, with an optional
 *  trailing action (close button, etc.). */
function SectionHeading({
  index,
  title,
  titleId,
  as: Heading = "h2",
  action,
}: {
  index: string;
  title: string;
  titleId?: string;
  as?: "h1" | "h2" | "h3";
  action?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <span className="section-index">{index}</span>
        <Heading id={titleId}>{title}</Heading>
      </div>
      {action}
    </div>
  );
}

export default SectionHeading;
