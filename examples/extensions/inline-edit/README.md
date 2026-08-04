# Inline edit extension

A miniature line editor for the file under review. Press `Ctrl-E`, type into the diff, press `Ctrl-S`, and Hunk writes the file back to your working tree after asking you first.

This example is **not bundled or loaded by Hunk**. Install it explicitly if you want it.

It exists to demonstrate that three extension-API capabilities compose, so it uses all three at once:

| Capability                       | Where this extension uses it                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.workspace`                  | `canWriteDocument` gates the affordance, `readDocument("new")` fills the buffer, `writeDocument` performs the consented write and reloads the review.                   |
| `mode` on a registered file view | `onKey` claims arrows, printable characters, Backspace, Enter, and `Ctrl-S`, and returns `"pass"` for everything else so the rest of Hunk keeps working while you edit. |
| `fileViews.refresh(viewId)`      | Every buffer or caret change re-derives the layout. A view's layout is a pure function of `(file, width)`, so this is the only way a stateful presentation redraws.     |

## Try it from this checkout

```bash
bun run src/main.tsx -- diff --extension ./examples/extensions/inline-edit
```

## Install it globally

Copy the whole folder — it has no dependencies:

```bash
mkdir -p ~/.config/hunk/extensions
cp -R examples/extensions/inline-edit ~/.config/hunk/extensions/
```

Hunk discovers the folder automatically on later launches. Open **View** and choose **File presentation: Inline edit**, or press `Ctrl-E`. The command is named `inline-edit.edit` for `[keybindings]` customization.

## Keys

| Key                     | Does                                                                          |
| ----------------------- | ----------------------------------------------------------------------------- |
| `Ctrl-E`                | First press shows the view; second press starts editing the selected file.    |
| `↑` `↓` `←` `→`         | Move the caret. `←`/`→` wrap across line ends.                                |
| any printable character | Types at the caret — including characters bound to Hunk commands, like `z`.   |
| `Backspace`             | Deletes back one character, joining with the previous line at column 0.       |
| `Enter`                 | Splits the line at the caret.                                                 |
| `Ctrl-S`                | Asks Hunk to write the buffer. Hunk confirms, writes, and reloads the review. |
| `Esc`                   | Leaves the editor and **discards** everything typed since the last write.     |
| everything else         | Still Hunk's: `]` moves to the next hunk, `?` opens help, `q` quits.          |

The header row reads `EDITING — Esc exits · ctrl+s writes`, plus a `MODIFIED` marker whenever the buffer differs from the text on disk.

## How the pieces fit

`onKey` has to answer synchronously — its return value _is_ the routing decision — and the mode context carries only `file` and `fileViews`. So a keystroke can never write anything itself. What `Ctrl-S` does instead is post a request into the edit session, and the command handler that entered the mode is still awaiting that session: `ctx.workspace` is valid for the whole life of a command handler's promise, so the handler is the mode's async runtime.

That loop ends the same way from every direction, because `onExit` runs on every exit path:

- **Saved.** A successful `writeDocument` reloads the session, the reload exits the mode, `onExit` ends the loop.
- **Escaped.** Escape is host-owned, so it exits the mode without ever reaching `onKey`, and the loop ends the same way.
- **Cancelled write.** `{ ok: false, reason: "cancelled" }` is the user answering, not a failure. The editor keeps running.
- **Failed write.** The `detail` sentence is shown as a warning and the editor keeps running, so nothing typed is lost to a full disk.

## Limitations

This is a demonstration, not an editor:

- **No wrapping.** Lines are truncated at the pane width with `…`. A file-view layout must be deterministic for `(file, width)`, and wrapping would be a second layout problem on top of the one this example is about.
- **Whole-line truncation.** The caret can move past the visible edge; the row does not scroll horizontally to follow it.
- **One buffer, no undo.** Escape discards everything since the last write, with no confirmation beyond the notice it leaves behind.
- **Writes are working-tree only**, which is a property of `ctx.workspace`: `hunk show`, `hunk patch`, a staged diff, and a file-pair diff have no working-tree document to replace, so the command refuses instead of opening an editor that could not save.
- **Agent notes anchor to source lines**, so they stay put while you edit but describe the document as it was loaded.

## Where this is documented

- [`docs/extensions.md` → Interactive file views](../../../docs/extensions.md#interactive-file-views)
- [`docs/extensions.md` → Reading and writing a reviewed file](../../../docs/extensions.md#reading-and-writing-a-reviewed-file)
- [`docs/extensions.md` → `hunk.registerFileView(view)`](../../../docs/extensions.md#hunkregisterfileviewview-experimental)
