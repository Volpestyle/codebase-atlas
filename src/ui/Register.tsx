import type { ReactNode } from "react";
import type { RepositoryNodeKind } from "../model";
import KindMark from "./KindMark";

export interface RegisterItem {
  id: string;
  label: string;
  value: ReactNode;
  kind?: RepositoryNodeKind;
  title?: string;
}

/** Numbered name/value list: contains, import partners, language register.
 *  Rows are buttons when onSelect is given, plain rows otherwise. */
function Register({
  items,
  onSelect,
}: {
  items: RegisterItem[];
  onSelect?: (id: string) => void;
}) {
  return (
    <ol className="register">
      {items.map((item) => {
        const content = (
          <>
            {item.kind ? <KindMark kind={item.kind} /> : null}
            <span>{item.label}</span>
            <b>{item.value}</b>
          </>
        );
        const rowClass = item.kind ? "has-kind" : undefined;
        return (
          <li key={item.id}>
            {onSelect ? (
              <button
                type="button"
                className={rowClass}
                title={item.title}
                onClick={() => onSelect(item.id)}
              >
                {content}
              </button>
            ) : (
              <div className={rowClass} title={item.title}>
                {content}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export default Register;
