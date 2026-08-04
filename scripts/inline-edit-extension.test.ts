import { describe, expect, test } from "bun:test";
import type {
  ExtensionCommand,
  ExtensionCommandHandler,
  ExtensionFileChangeRange,
  ExtensionFileView,
  ExtensionFileViewLayout,
  ExtensionKeyEvent,
  ExtensionWorkspaceWriteResult,
  HunkExtensionAPI,
} from "../src/extension-api/types";
import inlineEditExtension from "../examples/extensions/inline-edit";

const TEST_FILE = {
  id: "alpha",
  path: "alpha.ts",
  patch: "",
  stats: { additions: 1, deletions: 0 },
  metadata: {},
  agent: null,
  hunks: [{ index: 0, header: "@@ -1 +1,2 @@", newRange: [2, 2] }],
} as const;

const ADDED_SECOND_LINE: ExtensionFileChangeRange[] = [
  { hunkIndex: 0, kind: "added", range: [2, 2] },
];

/** Register the example against a fake API and keep what it contributed. */
function registerInlineEditTestExtension() {
  let view: ExtensionFileView | undefined;
  let command: ExtensionCommand | undefined;
  let commandHandler: ExtensionCommandHandler | undefined;
  inlineEditExtension({
    registerCommand(candidate: ExtensionCommand, handler: ExtensionCommandHandler) {
      command = candidate;
      commandHandler = handler;
    },
    registerFileView(candidate: ExtensionFileView) {
      view = candidate;
    },
  } as HunkExtensionAPI);
  return { view: view!, command: command!, commandHandler: commandHandler! };
}

/** Let every already-resolved promise in the handler's loop run to its next await. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Flatten one layout row to the text a terminal would show. */
function rowText(layout: ExtensionFileViewLayout | null, index: number) {
  return (layout?.rows[index]?.spans ?? []).map((span) => span.text).join("");
}

/**
 * Drive the example the way the host does.
 *
 * The fake owns the two things the real host owns and the extension only
 * observes: whether the view is the selected file's presentation, and the mode
 * lifecycle callbacks that fire around `enterMode`/`exitMode`.
 */
function createInlineEditTestHost({
  canWrite = true,
  document = "alpha\nbeta\n",
  write = async (): Promise<ExtensionWorkspaceWriteResult> => ({ ok: true }),
}: {
  canWrite?: boolean;
  document?: string | null;
  write?: (text: string) => Promise<ExtensionWorkspaceWriteResult>;
} = {}) {
  const { view, command, commandHandler } = registerInlineEditTestExtension();
  const notices: { message: string; type?: string }[] = [];
  const refreshed: string[] = [];
  const selected: (string | null)[] = [];
  const writes: string[] = [];
  const documentReads: string[] = [];
  let viewActive = false;
  let modeActive = false;

  const fileViews = {
    isActive: () => viewActive,
    select: (viewId: string | null) => selected.push(viewId),
    refresh: (viewId: string) => refreshed.push(viewId),
    isModeActive: () => modeActive,
    enterMode: () => {
      if (!viewActive) {
        return false;
      }
      modeActive = true;
      view.mode?.onEnter?.({ ...modeContext(), file: TEST_FILE } as never);
      return true;
    },
    exitMode: () => {
      if (!modeActive) {
        return;
      }
      modeActive = false;
      view.mode?.onExit?.(modeContext() as never);
    },
  };
  const notify = (message: string, type?: string) => notices.push({ message, type });
  const modeContext = () => ({ cwd: "/repo", file: TEST_FILE, fileViews, notify });

  const ctx = {
    cwd: "/repo",
    notify,
    fileViews,
    selection: { file: TEST_FILE, hunkIndex: 0 },
    workspace: {
      canWriteDocument: () => canWrite,
      readDocument: async (fileId: string) => {
        documentReads.push(fileId);
        return document;
      },
      writeDocument: async ({ text }: { fileId: string; text: string }) => {
        writes.push(text);
        return write(text);
      },
    },
  };

  return {
    command,
    documentReads,
    notices,
    refreshed,
    selected,
    view,
    writes,
    isModeActive: () => modeActive,
    /** Run the command exactly as a keypress would, without awaiting its loop. */
    run: () => commandHandler(ctx as never),
    /** Mark the view as the selected file's presentation, as a repaint would. */
    activateView: () => {
      viewActive = true;
    },
    /** Deliver one key to the mode, answering `"pass"` when no mode is running. */
    press: (key: ExtensionKeyEvent) =>
      modeActive ? view.mode?.onKey(key, modeContext() as never) : "pass",
    /** Escape is host-owned: it exits without ever reaching `onKey`. */
    escape: () => fileViews.exitMode(),
    /** Lay the current file out at a fixed width, as the review stream does. */
    layout: (changes: ExtensionFileChangeRange[] = []) =>
      view.layout({
        file: TEST_FILE,
        width: 40,
        signal: new AbortController().signal,
        changes,
        readDocument: async () => {
          documentReads.push("view");
          return document;
        },
      } as never) as Promise<ExtensionFileViewLayout | null>,
  };
}

describe("inline edit example extension", () => {
  test("registers one interactive file view and one command on a free chord", () => {
    const host = createInlineEditTestHost();
    expect(host.command).toMatchObject({ id: "edit", key: "ctrl+e" });
    expect(host.view.id).toBe("inline-edit");
    expect(typeof host.view.mode?.onKey).toBe("function");
    expect(host.view.matches({ path: "alpha.ts" } as never)).toBe(true);
    expect(host.view.matches({ path: "logo.png", isBinary: true } as never)).toBe(false);
  });

  test("renders the read document with line numbers, added tone, and source bindings", async () => {
    const host = createInlineEditTestHost();
    const layout = await host.layout(ADDED_SECOND_LINE);

    expect(layout?.rows).toEqual([
      {
        id: "line:1",
        spans: [{ text: " 1 ", tone: "muted" }, { text: "alpha" }],
        sourceRanges: [{ side: "new", range: [1, 1] }],
      },
      {
        id: "line:2",
        spans: [
          { text: " 2 ", tone: "muted" },
          { text: "beta", tone: "added" },
        ],
        sourceRanges: [{ side: "new", range: [2, 2] }],
      },
    ]);
    expect(layout?.hunkRows).toEqual([{ startRow: 1, endRow: 1 }]);
  });

  test("declines the file when the new-side document is unreadable", async () => {
    const host = createInlineEditTestHost({ document: null });
    await expect(host.layout()).resolves.toBeNull();
  });

  test("selects the view first and enters the mode on the next press", async () => {
    const host = createInlineEditTestHost();

    await host.run();
    expect(host.selected).toEqual(["inline-edit"]);
    expect(host.isModeActive()).toBe(false);
    expect(host.notices.at(-1)?.message).toContain("press ctrl+e again");
    expect(host.documentReads).toEqual([]);

    host.activateView();
    void host.run();
    await flush();
    expect(host.isModeActive()).toBe(true);
    expect(host.documentReads).toEqual(["alpha"]);
    // `onEnter` asks for the redraw that swaps the read-only rows for the buffer.
    expect(host.refreshed).toEqual(["inline-edit"]);
  });

  test("refuses to edit a review it could not write back to", async () => {
    const host = createInlineEditTestHost({ canWrite: false });
    host.activateView();

    await host.run();
    expect(host.isModeActive()).toBe(false);
    expect(host.documentReads).toEqual([]);
    expect(host.notices.at(-1)).toMatchObject({ type: "warning" });
    expect(host.notices.at(-1)?.message).toContain("working-tree diff");
  });

  test("renders the buffer, the caret, and the editing header while a session runs", async () => {
    const host = createInlineEditTestHost();
    host.activateView();
    void host.run();
    await flush();

    const layout = await host.layout(ADDED_SECOND_LINE);
    // The buffer is the document now, so nothing is re-read behind the editor.
    expect(host.documentReads).toEqual(["alpha"]);
    expect(rowText(layout, 0)).toBe("EDITING — Esc exits · ctrl+s writes");
    expect(rowText(layout, 1)).toBe(" 1 alpha");
    // The caret starts on the selected hunk's first new-side line.
    expect(layout?.rows[2]?.spans).toEqual([
      { text: "▎2 ", tone: "accent" },
      { text: "b", tone: "accent", attributes: ["underline", "bold"] },
      { text: "eta" },
    ]);
    // Added tone belongs to the read-only presentation; an edited buffer's line
    // numbers no longer describe the changeset.
    expect(layout?.rows.flatMap((row) => row.spans).some((span) => span.tone === "added")).toBe(
      false,
    );
    expect(layout?.hunkRows).toEqual([{ startRow: 2, endRow: 2 }]);
  });

  test("types, splits, joins, and moves the caret, refreshing on every change", async () => {
    const host = createInlineEditTestHost();
    host.activateView();
    void host.run();
    await flush();
    const refreshesBefore = host.refreshed.length;

    expect(host.press({ name: "z", sequence: "z" })).toBe("handled");
    expect(host.press({ name: "space", sequence: " " })).toBe("handled");
    expect(rowText(await host.layout(), 2)).toBe("▎2 z beta");

    expect(host.press({ name: "backspace", sequence: "" })).toBe("handled");
    expect(rowText(await host.layout(), 2)).toBe("▎2 zbeta");

    expect(host.press({ name: "return", sequence: "\r" })).toBe("handled");
    let layout = await host.layout();
    expect(rowText(layout, 2)).toBe(" 2 z");
    expect(rowText(layout, 3)).toBe("▎3 beta");

    // Backspace at column 0 joins the split back together.
    expect(host.press({ name: "backspace", sequence: "" })).toBe("handled");
    expect(rowText(await host.layout(), 2)).toBe("▎2 zbeta");

    expect(host.press({ name: "up" })).toBe("handled");
    expect(host.press({ name: "right" })).toBe("handled");
    layout = await host.layout();
    expect(rowText(layout, 1)).toBe("▎1 alpha");
    expect(layout?.rows[1]?.spans[2]).toEqual({
      text: "p",
      tone: "accent",
      attributes: ["underline", "bold"],
    });

    // Every buffer or caret change asked for its own redraw.
    expect(host.refreshed.length - refreshesBefore).toBe(7);
    expect(host.refreshed.every((viewId) => viewId === "inline-edit")).toBe(true);
    expect(rowText(await host.layout(), 0)).toContain("MODIFIED");
  });

  test("claims printable keys bound to commands and passes on everything else", async () => {
    const host = createInlineEditTestHost();
    host.activateView();
    void host.run();
    await flush();
    const refreshesBefore = host.refreshed.length;

    // `]` is Hunk's next-hunk key; while the editor runs it is text.
    expect(host.press({ name: "]", sequence: "]" })).toBe("handled");
    expect(host.press({ name: "tab", sequence: "\t" })).toBe("pass");
    expect(host.press({ name: "f8" })).toBe("pass");
    expect(host.press({ name: "g", sequence: "g", ctrl: true })).toBe("pass");
    expect(host.refreshed.length - refreshesBefore).toBe(1);
  });

  test("writes the buffer on ctrl+s, preserving the document's trailing newline", async () => {
    const host = createInlineEditTestHost();
    host.activateView();
    const running = host.run();
    await flush();

    // Nothing to write yet: the buffer still matches what was loaded.
    expect(host.press({ name: "s", ctrl: true })).toBe("handled");
    await flush();
    expect(host.writes).toEqual([]);
    expect(host.notices.at(-1)?.message).toBe("No unsaved edits");

    host.press({ name: "z", sequence: "z" });
    expect(host.press({ name: "s", ctrl: true })).toBe("handled");
    await flush();
    expect(host.writes).toEqual(["alpha\nzbeta\n"]);
    expect(host.notices.at(-1)?.message).toBe("Wrote alpha.ts");
    expect(rowText(await host.layout(), 0)).not.toContain("MODIFIED");

    // In the real host the write's reload exits the mode; here the exit stands
    // in for it, and either way `onExit` is what ends the handler's loop.
    host.escape();
    await running;
    expect(host.isModeActive()).toBe(false);
  });

  test("reports a failed write and keeps editing, and a cancelled one silently", async () => {
    const results: ExtensionWorkspaceWriteResult[] = [
      { ok: false, reason: "cancelled", detail: "The write to alpha.ts was declined." },
      { ok: false, reason: "failed", detail: "Failed to write alpha.ts • EACCES" },
    ];
    const host = createInlineEditTestHost({
      write: async () => results.shift() ?? { ok: true },
    });
    host.activateView();
    const running = host.run();
    await flush();
    host.press({ name: "z", sequence: "z" });

    host.press({ name: "s", ctrl: true });
    await flush();
    // A declined write is the user answering, not something to report.
    expect(host.notices).toEqual([]);
    expect(host.isModeActive()).toBe(true);

    host.press({ name: "s", ctrl: true });
    await flush();
    expect(host.notices.at(-1)).toMatchObject({
      message: "Failed to write alpha.ts • EACCES",
      type: "warning",
    });
    expect(host.isModeActive()).toBe(true);

    host.escape();
    await running;
  });

  test("escape discards the buffer, clears the session, and settles the handler", async () => {
    const host = createInlineEditTestHost();
    host.activateView();
    const running = host.run();
    await flush();
    host.press({ name: "z", sequence: "z" });

    host.escape();
    await running;

    expect(host.writes).toEqual([]);
    expect(host.notices.at(-1)?.message).toBe("Discarded unsaved edits to alpha.ts");
    // The session is gone: the view is back to rendering the document it reads.
    expect(rowText(await host.layout(), 0)).toBe(" 1 alpha");
    expect(host.press({ name: "z", sequence: "z" })).toBe("pass");
  });
});
