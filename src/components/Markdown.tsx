import { Fragment, type ReactNode } from "react";

// A deliberately tiny Markdown renderer for chat replies: paragraphs, bullet and
// numbered lists, headings, **bold**, `code` and links. It builds React
// elements (no innerHTML), so model output can't inject markup.

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s)]+)/g;

function safeHref(href: string) {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (!part) return null;
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="rounded bg-zinc-100 px-1 py-0.5 text-[0.9em] dark:bg-zinc-800">
          {part.slice(1, -1)}
        </code>
      );
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    const href = safeHref(link ? link[2] : part);
    if ((link || /^https?:\/\//.test(part)) && href) {
      return (
        <a
          key={i}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-teal-700 underline underline-offset-2 hover:text-teal-900 dark:text-teal-400 dark:hover:text-teal-300"
        >
          {link ? link[1] : part}
        </a>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = line.match(/^#{1,4}\s+(.*)/);
    if (heading) {
      blocks.push(
        <p key={i} className="font-semibold">
          {inline(heading[1])}
        </p>,
      );
      i++;
      continue;
    }

    const listMatch = /^\s*([-*•]|\d+[.)])\s+/;
    if (listMatch.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && listMatch.test(lines[i])) {
        items.push(<li key={i}>{inline(lines[i].replace(listMatch, ""))}</li>);
        i++;
      }
      blocks.push(
        ordered ? (
          <ol key={`l${i}`} className="list-decimal space-y-1 pl-5">
            {items}
          </ol>
        ) : (
          <ul key={`l${i}`} className="list-disc space-y-1 pl-5">
            {items}
          </ul>
        ),
      );
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !listMatch.test(lines[i]) && !/^#{1,4}\s/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={`p${i}`}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(p)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return <div className="space-y-3 leading-relaxed">{blocks}</div>;
}
