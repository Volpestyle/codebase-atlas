import { useState } from "react";
import type { Story } from "./model";
import { storyMermaid } from "./mermaid";

export default function MermaidCopy({ story, journeyIndex }: { story: Story; journeyIndex?: number }) {
  const [result, setResult] = useState<{ text: string; copied: boolean }>();
  const text = storyMermaid(story, journeyIndex);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setResult({ text, copied: true }); }
    catch { setResult({ text, copied: false }); }
  }
  const current = result?.text === text ? result : undefined;
  return <div className="mermaid-copy"><button onClick={copy}>Copy as Mermaid</button>
    {current && <span role="status" className="atlas-muted">{current.copied ? "Mermaid copied" : "Copy unavailable. Select the Mermaid text below."}</span>}
    {current && !current.copied && <textarea aria-label="Mermaid export" readOnly value={text} onFocus={event => event.currentTarget.select()} />}
  </div>;
}
