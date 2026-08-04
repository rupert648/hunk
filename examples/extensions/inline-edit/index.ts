/**
 * Inline edit — a miniature line editor for the file under review.
 *
 * This is the demonstration three extension-API capabilities were built for,
 * and the proof that they compose:
 *
 * - `ctx.workspace` fills the buffer with `readDocument`, gates the affordance
 *   with `canWriteDocument`, and performs the consented `writeDocument`.
 * - a file view `mode` routes real keystrokes into the view: it claims arrows,
 *   printable characters, Backspace, Enter, and Ctrl-S, and declines the rest
 *   so `]`, `?`, and `q` keep working while the editor is running.
 * - `fileViews.refresh` re-derives the layout after every buffer or caret
 *   change, which is the only way a stateful view redraws at all.
 *
 * The load-bearing shape is the command handler. `onKey` must answer
 * synchronously, and the mode context deliberately carries only `file` and
 * `fileViews` — so a keystroke can only *request* a save. `ctx.workspace` is
 * valid for the whole life of a command handler's promise, so the handler that
 * entered the mode parks on a session lifecycle loop and is the thing that
 * actually writes. Every exit path — the reload after a save, Escape, a
 * host auto-exit — runs `onExit`, which ends that loop, so the handler always
 * settles and no promise is left dangling.
 */

import type {
  ExtensionDiffFile,
  ExtensionFactory,
  ExtensionFileChangeRange,
  ExtensionFileViewRow,
  ExtensionFileViewSpan,
  ExtensionKeyEvent,
} from "hunkdiff/extension";

/** The registered view id. This folder's extension id is `inline-edit` too. */
const VIEW_ID = "inline-edit";
const HEADER_LABEL = "EDITING — Esc exits · ctrl+s writes";
const MODIFIED_MARKER = "  MODIFIED";
/** Ctrl-S as some terminals report it: a bare control character, no `ctrl` flag. */
const CTRL_S_SEQUENCE = "\u0013";
/** Marks the cursor line in the gutter, where an editor would show a caret. */
const CURSOR_MARK = "▎";

/** What the mode can ask its command handler for, between keystrokes. */
type SessionRequest = "save" | "end";

/**
 * One file's live edit buffer, plus the mailbox the mode talks to the command
 * handler through.
 *
 * The mailbox is the whole trick: `requestSave` and `end` are synchronous, so
 * `onKey` and `onExit` can call them and answer immediately, while `next()` is
 * what the async handler awaits.
 */
interface EditSession {
  readonly fileId: string;
  readonly path: string;
  /** The line terminator the document was read with, preserved on write. */
  readonly newline: string;
  /** Whether the document ended with a terminator, also preserved on write. */
  readonly endsWithNewline: boolean;
  /** Line count at load time; source-line bindings never claim more than this. */
  readonly documentLineCount: number;
  /** Mutated in place — never reassigned, since `text()` closes over it. */
  readonly lines: string[];
  /** The text on disk as far as this session knows, so `MODIFIED` is a fact. */
  savedText: string;
  cursorLine: number;
  cursorColumn: number;
  /** Ask the command handler to write the buffer. Answers immediately. */
  requestSave(): void;
  /** Tell the handler the session is over. Every exit path calls this. */
  end(): void;
  /** Await the next request. Resolves `"end"` forever once the session ended. */
  next(): Promise<SessionRequest>;
  /** The buffer as one document, with the read's line endings restored. */
  text(): string;
}

/** Clamp a value into an inclusive range. */
function clamp(value: number, low: number, high: number) {
  return Math.min(Math.max(value, low), high);
}

/** Cut text to a column budget, marking the cut so truncation is never silent. */
function truncate(value: string, width: number) {
  if (value.length <= width) {
    return value;
  }
  return width <= 1 ? value.slice(0, Math.max(0, width)) : `${value.slice(0, width - 1)}…`;
}

/** Split a document into editable lines, dropping the terminator's empty tail. */
function splitDocumentLines(text: string) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines.length > 0 ? lines : [""];
}

/** Collect the new-side line numbers this changeset added, for read-only tone. */
function addedLineNumbers(changes: readonly ExtensionFileChangeRange[]) {
  const added = new Set<number>();
  for (const change of changes) {
    if (change.kind !== "added") {
      continue;
    }
    for (let line = change.range[0]; line <= change.range[1]; line += 1) {
      added.add(line);
    }
  }
  return added;
}

/**
 * The character a key would type, or `null` for anything that is not text.
 *
 * A mode receives every key the app's modal surfaces did not claim, so deciding
 * what counts as typing is the extension's job: one character, no modifier that
 * turns it into a chord, and nothing in the C0/DEL control range (which is how
 * Enter, Tab, Backspace, and Ctrl-S arrive).
 */
function printableCharacter(key: ExtensionKeyEvent) {
  if (key.ctrl === true || key.meta === true || key.option === true) {
    return null;
  }
  const sequence = key.sequence ?? "";
  if (sequence.length !== 1) {
    return null;
  }
  const code = sequence.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f ? sequence : null;
}

/** Match Ctrl-S across the encodings terminals disagree about. */
function isSaveKey(key: ExtensionKeyEvent) {
  return (key.ctrl === true && key.name?.toLowerCase() === "s") || key.sequence === CTRL_S_SEQUENCE;
}

/** Match Enter across the two names key parsers report it under. */
function isEnterKey(key: ExtensionKeyEvent) {
  return key.name === "return" || key.name === "enter";
}

/** Build one file's edit session from the exact document text behind it. */
function createEditSession(file: ExtensionDiffFile, text: string, cursorLine: number): EditSession {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const endsWithNewline = /\r?\n$/.test(text);
  const lines = splitDocumentLines(text);

  let pending: ((request: SessionRequest) => void) | null = null;
  let queued: SessionRequest | null = null;
  let ended = false;

  /** Hand one request to the waiting handler, or hold it until one waits. */
  const post = (request: SessionRequest) => {
    if (ended) {
      return;
    }
    if (request === "end") {
      ended = true;
    }
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve(request);
      return;
    }
    // `"end"` supersedes a held save: once the session is over, the write that
    // save asked for no longer belongs to anything.
    queued = request === "end" ? "end" : (queued ?? "save");
  };

  const session: EditSession = {
    fileId: file.id,
    path: file.path,
    newline,
    endsWithNewline,
    documentLineCount: lines.length,
    lines,
    // Normalized rather than the raw read, so a document with mixed terminators
    // is not reported as modified before anyone has typed into it.
    savedText: lines.join(newline) + (endsWithNewline ? newline : ""),
    cursorLine: clamp(cursorLine, 0, lines.length - 1),
    cursorColumn: 0,
    requestSave: () => post("save"),
    end: () => post("end"),
    next() {
      if (queued !== null) {
        const request = queued;
        queued = null;
        return Promise.resolve(request);
      }
      // An ended session answers instantly, so a handler can never park on a
      // promise nothing is left to resolve.
      if (ended) {
        return Promise.resolve<SessionRequest>("end");
      }
      return new Promise<SessionRequest>((resolve) => {
        pending = resolve;
      });
    },
    text: () => lines.join(newline) + (endsWithNewline ? newline : ""),
  };
  return session;
}

/** Keep the caret inside the buffer after any edit or movement. */
function clampCursor(session: EditSession) {
  session.cursorLine = clamp(session.cursorLine, 0, session.lines.length - 1);
  const line = session.lines[session.cursorLine] ?? "";
  session.cursorColumn = clamp(session.cursorColumn, 0, line.length);
}

/** Insert typed text at the caret. */
function insertText(session: EditSession, text: string) {
  const line = session.lines[session.cursorLine] ?? "";
  session.lines[session.cursorLine] =
    line.slice(0, session.cursorColumn) + text + line.slice(session.cursorColumn);
  session.cursorColumn += text.length;
  clampCursor(session);
}

/** Delete backwards, joining with the previous line at column 0. */
function deleteBackwards(session: EditSession) {
  const line = session.lines[session.cursorLine] ?? "";
  if (session.cursorColumn > 0) {
    session.lines[session.cursorLine] =
      line.slice(0, session.cursorColumn - 1) + line.slice(session.cursorColumn);
    session.cursorColumn -= 1;
    clampCursor(session);
    return;
  }
  if (session.cursorLine === 0) {
    return;
  }
  const previous = session.lines[session.cursorLine - 1] ?? "";
  session.lines.splice(session.cursorLine - 1, 2, previous + line);
  session.cursorLine -= 1;
  session.cursorColumn = previous.length;
  clampCursor(session);
}

/** Split the current line at the caret. */
function splitLine(session: EditSession) {
  const line = session.lines[session.cursorLine] ?? "";
  session.lines.splice(
    session.cursorLine,
    1,
    line.slice(0, session.cursorColumn),
    line.slice(session.cursorColumn),
  );
  session.cursorLine += 1;
  session.cursorColumn = 0;
  clampCursor(session);
}

/** Move the caret one line or one column, wrapping columns across line ends. */
function moveCursor(session: EditSession, key: ExtensionKeyEvent) {
  if (key.name === "up" || key.name === "down") {
    session.cursorLine += key.name === "down" ? 1 : -1;
    clampCursor(session);
    return;
  }
  if (key.name === "left") {
    if (session.cursorColumn === 0 && session.cursorLine > 0) {
      session.cursorLine -= 1;
      session.cursorColumn = (session.lines[session.cursorLine] ?? "").length;
    } else {
      session.cursorColumn -= 1;
    }
    clampCursor(session);
    return;
  }
  const line = session.lines[session.cursorLine] ?? "";
  if (session.cursorColumn >= line.length && session.cursorLine < session.lines.length - 1) {
    session.cursorLine += 1;
    session.cursorColumn = 0;
  } else {
    session.cursorColumn += 1;
  }
  clampCursor(session);
}

/** Render the editing header, which is also where `MODIFIED` is reported. */
function headerRow(session: EditSession, width: number): ExtensionFileViewRow {
  const marker = session.text() === session.savedText ? "" : MODIFIED_MARKER;
  // The marker outranks the key legend when columns are tight: unsaved work is
  // the more important half of this row.
  const label = truncate(HEADER_LABEL, Math.max(0, width - marker.length));
  const spans: ExtensionFileViewSpan[] = [];
  if (label.length > 0) {
    spans.push({ text: label, tone: "accent", attributes: ["bold"] });
  }
  if (marker.length > 0) {
    spans.push({ text: truncate(marker, width), tone: "added", attributes: ["bold"] });
  }
  // Every row has to occupy a terminal cell, however narrow the pane got.
  return { id: "editing", spans: spans.length > 0 ? spans : [{ text: " " }] };
}

/**
 * A whole-file inline editor for the reviewed document.
 *
 * Every piece of mutable state lives in this closure, keyed to the file it
 * belongs to, so nothing leaks between files or between Hunk sessions.
 */
const inlineEditExtension: ExtensionFactory = (hunk) => {
  // At most one session exists at a time — the host allows one active mode
  // app-wide — but it is tagged with its file so a layout for any *other* file
  // presenting this view still renders read-only.
  let editSession: EditSession | null = null;
  const sessionFor = (fileId: string) => (editSession?.fileId === fileId ? editSession : null);

  hunk.registerFileView({
    id: VIEW_ID,
    title: "Inline edit",
    matches(file) {
      // Any file Hunk read as text. A deleted file matches too and is declined
      // by `layout` below, where the missing new side actually shows up.
      return file.isBinary !== true && file.isTooLarge !== true;
    },
    async layout(input) {
      const session = sessionFor(input.file.id);
      // While a session is live the buffer *is* the document: re-reading would
      // throw away everything typed since the last write.
      const document = session ? null : await input.readDocument("new");
      if (!session && document === null) {
        return null;
      }
      if (input.signal.aborted) {
        return null;
      }

      const lines = session ? session.lines : splitDocumentLines(document ?? "");
      const numberWidth = String(Math.max(lines.length, 1)).length;
      // The caret cell is reserved in both states, so entering the mode changes
      // what the rows say without reflowing where the text starts.
      const gutterWidth = numberWidth + 2;
      const textWidth = Math.max(1, input.width - gutterWidth);
      // Added-line tone belongs to the read-only presentation only: once the
      // buffer is edited, the changeset's line numbers no longer describe it.
      const added = session ? new Set<number>() : addedLineNumbers(input.changes);
      const headerOffset = session ? 1 : 0;

      const rows: ExtensionFileViewRow[] = [];
      if (session) {
        rows.push(headerRow(session, input.width));
      }

      lines.forEach((line, index) => {
        const lineNumber = index + 1;
        const onCursor = session !== null && index === session.cursorLine;
        const visible = truncate(line, textWidth);
        const spans: ExtensionFileViewSpan[] = [
          {
            text: `${onCursor ? CURSOR_MARK : " "}${String(lineNumber).padStart(numberWidth)} `,
            tone: onCursor ? "accent" : "muted",
          },
        ];

        if (session && onCursor) {
          // Three spans put the caret on a column without needing an inverse
          // attribute the row contract does not have.
          const caret = clamp(session.cursorColumn, 0, visible.length);
          if (caret > 0) {
            spans.push({ text: visible.slice(0, caret) });
          }
          spans.push({
            text: visible.slice(caret, caret + 1) || " ",
            tone: "accent",
            attributes: ["underline", "bold"],
          });
          if (caret + 1 < visible.length) {
            spans.push({ text: visible.slice(caret + 1) });
          }
        } else if (added.has(lineNumber)) {
          spans.push({ text: visible, tone: "added" });
        } else {
          spans.push({ text: visible });
        }

        rows.push({
          id: `line:${lineNumber}`,
          spans,
          // One row per source line is what lets Hunk place inline agent notes
          // inside this presentation. A buffer that grew past the document it
          // was loaded from stops binding rather than claiming lines the file
          // does not have.
          ...(lineNumber <= (session?.documentLineCount ?? lines.length)
            ? { sourceRanges: [{ side: "new" as const, range: [lineNumber, lineNumber] as const }] }
            : {}),
        });
      });

      const rowForLine = (line: number) =>
        clamp(headerOffset + line - 1, 0, Math.max(rows.length - 1, 0));
      return {
        rows,
        hunkRows: (input.file.hunks ?? []).map((entry) => {
          const [start, end] = entry.newRange ?? [1, 1];
          return { startRow: rowForLine(start), endRow: rowForLine(end) };
        }),
      };
    },
    mode: {
      onEnter(ctx) {
        // The session was created before `enterMode`, so this is the redraw
        // that swaps the read-only rows for the editable buffer.
        ctx.fileViews.refresh(VIEW_ID);
      },
      onKey(key, ctx) {
        const session = sessionFor(ctx.file.id);
        if (!session) {
          // No buffer means nothing here is an editor; decline rather than
          // swallow keys the review still has uses for.
          return "pass";
        }

        // Requested, never performed: `onKey` answers synchronously, and the
        // write lives on the command handler's promise with `ctx.workspace`.
        if (isSaveKey(key)) {
          session.requestSave();
          return "handled";
        }

        if (
          key.name === "up" ||
          key.name === "down" ||
          key.name === "left" ||
          key.name === "right"
        ) {
          moveCursor(session, key);
        } else if (key.name === "backspace") {
          deleteBackwards(session);
        } else if (isEnterKey(key)) {
          splitLine(session);
        } else {
          const character = printableCharacter(key);
          if (character === null) {
            // Everything the editor has no use for stays Hunk's: `]` still
            // moves to the next hunk and `?` still opens the help overlay.
            return "pass";
          }
          insertText(session, character);
        }

        // A stateful view has no `(file, width)` change to announce, so this is
        // how every keystroke reaches the screen.
        ctx.fileViews.refresh(VIEW_ID);
        return "handled";
      },
      onExit(ctx) {
        const ending = editSession;
        editSession = null;
        // The only thing that ends the command handler's loop. Escape, a
        // reload after a write, and a host auto-exit all arrive here.
        ending?.end();
        ctx.fileViews.refresh(VIEW_ID);
      },
    },
  });

  hunk.registerCommand(
    { id: "edit", title: "Edit the selected file inline", key: "ctrl+e" },
    async (ctx) => {
      const file = ctx.selection.file;
      if (!file) {
        ctx.notify("Select a file to edit", "warning");
        return;
      }

      // `onKey` passes on Ctrl-E, so this command is reachable from inside its
      // own mode. Answer it instead of starting a second session on one file.
      if (editSession !== null) {
        ctx.notify(`Already editing ${editSession.path} — Esc exits, ctrl+s writes`);
        return;
      }

      // Documented sequencing: a `select` in this handler has not repainted
      // yet, so entering the mode belongs to a later keypress.
      if (!ctx.fileViews.isActive(VIEW_ID)) {
        ctx.fileViews.select(VIEW_ID);
        ctx.notify("Inline edit is showing — press ctrl+e again to start editing");
        return;
      }

      // The affordance gate. Reads work in every review kind, but writes are
      // working-tree only, and an editor that cannot save is a lie.
      if (!ctx.workspace.canWriteDocument(file.id)) {
        ctx.notify(
          `${file.path} cannot be written from this review — inline edit needs a working-tree diff`,
          "warning",
        );
        return;
      }

      const document = await ctx.workspace.readDocument(file.id, "new");
      if (document === null) {
        ctx.notify(`No readable document for ${file.path}`, "warning");
        return;
      }

      // Start on the hunk the user was looking at, so editing opens where the
      // review already pointed.
      const hunks = file.hunks ?? [];
      const selectedHunk = hunks[ctx.selection.hunkIndex ?? 0] ?? hunks[0];
      const session = createEditSession(file, document, (selectedHunk?.newRange?.[0] ?? 1) - 1);

      editSession = session;
      if (!ctx.fileViews.enterMode(VIEW_ID)) {
        // `enterMode` already warned naming the refusal; drop the buffer that
        // now has no keyboard behind it.
        editSession = null;
        return;
      }

      // From here this handler *is* the mode's runtime. It stays parked on the
      // session's mailbox until something ends the session, which is why the
      // write can be async while `onKey` stays synchronous.
      for (let request = await session.next(); request !== "end"; request = await session.next()) {
        const text = session.text();
        if (text === session.savedText) {
          ctx.notify("No unsaved edits");
          continue;
        }

        const result = await ctx.workspace.writeDocument({ fileId: session.fileId, text });
        if (result.ok) {
          session.savedText = text;
          ctx.notify(`Wrote ${session.path}`);
          // Hunk reloads the review after a successful write, and a reload
          // exits the mode — `onExit` posts the `"end"` this loop stops on.
          continue;
        }
        if (result.reason === "cancelled") {
          // The user answered the question. Keep editing.
          continue;
        }
        ctx.notify(result.detail, "warning");
      }

      if (session.text() !== session.savedText) {
        ctx.notify(`Discarded unsaved edits to ${session.path}`);
      }
    },
  );
};

export default inlineEditExtension;
