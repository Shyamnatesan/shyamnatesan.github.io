import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  cpSync,
  watch,
} from "fs";

const SITE_TITLE = "notes";

function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
${body}
</body>
</html>
`;
}

type Note = { date: string; slug: string; title: string; html: string };

function readNote(fileName: string): Note {
  const match = fileName.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.md$/);
  if (!match)
    throw new Error(`${fileName}: name must look like 2026-11-19-name.md`);
  const [, date, slug] = match;

  const text = readFileSync(`notes/${fileName}`, "utf8");
  const firstLineEnd = text.indexOf("\n");
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  if (!firstLine.startsWith("# "))
    throw new Error(
      `${fileName}: first line must be the title, like "# fsync"`,
    );

  const title = firstLine.slice(2).trim();
  const rest = firstLineEnd === -1 ? "" : text.slice(firstLineEnd + 1);
  return { date, slug, title, html: Bun.markdown.html(rest) };
}

function build() {
  const notes = readdirSync("notes")
    .filter((name) => name.endsWith(".md"))
    .sort()
    .reverse()
    .map(readNote);

  rmSync("dist", { recursive: true, force: true });
  mkdirSync("dist");
  cpSync("style.css", "dist/style.css");
  cpSync("fonts", "dist/fonts", { recursive: true });

  for (const note of notes) {
    const body = `<p><a href="index.html">&larr; home</a></p>

<h1>${escape(note.title)}</h1>
<p class="date">${note.date}</p>

${note.html}`;
    writeFileSync(
      `dist/${note.slug}.html`,
      page(`${note.title} - ${SITE_TITLE}`, body),
    );
  }

  const list = notes
    .map(
      (n) =>
        `  <li><span class="date">${n.date}</span> <a href="${n.slug}.html">${escape(n.title)}</a></li>`,
    )
    .join("\n");
  writeFileSync(
    "dist/index.html",
    page(
      SITE_TITLE,
      `<h1>${SITE_TITLE}</h1>\n\n<ul class="list">\n${list}\n</ul>`,
    ),
  );

  console.log(`built ${notes.length} note(s) into dist/`);
}

function tryBuild() {
  try {
    build();
  } catch (err) {
    console.error(String(err));
  }
}

if (process.argv[2] === "serve") {
  tryBuild();

  for (const path of ["notes", "fonts", "style.css"])
    watch(path, { recursive: true }, tryBuild);

  Bun.serve({
    port: 3000,
    async fetch(req) {
      let path = new URL(req.url).pathname;
      if (path.endsWith("/")) path += "index.html";
      const file = Bun.file(`dist${decodeURIComponent(path)}`);
      return (await file.exists())
        ? new Response(file)
        : new Response("not found", { status: 404 });
    },
  });
  console.log("open http://localhost:3000");
} else {
  build();
}
