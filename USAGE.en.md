# Easy Left Right Diff | Usage and Troubleshooting

This extension uses the standard VS Code/Cursor diff editor while making the real L (left) and R (right) files and copy direction easier to identify.

## Compare two files selected together

### From Explorer

#### Right-click one file

1. Right-click the first file.
2. Choose `Easy Left Right Diff` → `Compare Two Selected Files as L and R`.
3. A confirmation states that the first file is already selected and shows its full path. Choose `Choose the second file`.
4. In the file picker, choose only the second file to compare.
5. Choose which file should be L / Left.
6. Confirm both file names and locations, then start a normal or read-only comparison.

#### Select two files first

1. Hold `Ctrl` and select exactly two files.
2. Right-click either selected file.
3. Choose `Easy Left Right Diff` → `Compare Two Selected Files as L and R`.
4. Choose which file should be L / Left.
5. Confirm both file names and locations, then start a normal or read-only comparison.

### From the L/R confirmation view

When neither side is set, click `Or: choose two files and compare them together`. Choose exactly two files in the file picker, then explicitly choose which one should be L / Left.

Selection order never decides L and R. The comparison does not start for anything other than two distinct files or when the side choice is cancelled.

## The shortest three-step workflow

1. Right-click the first file and choose `Easy Left Right Diff` → `Set This File as L (Left)`.
2. Right-click the second file and choose `Easy Left Right Diff` → `Set This File as R (Right) and Compare`.
3. Check the L/R file names and locations, then start a normal or read-only comparison.

You can also click the numbered guidance items in the L/R confirmation view and choose files from a file picker.

## Reading the comparison view

- L and R remain fixed during the comparison.
- The standard diff is one diff tab. Moving the tab to another editor group does not swap L and R.
- “Currently active” means the side where the extension last detected text-caret movement or scrolling. It does not mean source, accepted side, or save destination. The status-bar item uses the theme’s normal foreground color so it remains readable against the status-bar background.
- For same-name files, check the distinguishing location, workspace, and full path.
- “Show L and R Addresses” displays both full paths with clear separators.

## Copying the current change

1. Place the text caret inside the change in the standard diff editor.
2. Choose a copy direction from the L/R view or the diff editor context menu.
3. Confirm L → R or R → L and the real file that will be changed.
4. The target becomes unsaved. Use the target side’s “Save Changes to File” item in the L/R view and confirm the exact file. You can also use `Ctrl+S` or File → Save.

The extension stops safely when it cannot identify one unique change.

## Copying the entire file

Use “Copy Entire L File to R” or the reverse command. Whole-file copy always asks you to confirm the direction and target.

## Reverting a copied change

“Revert the Last Copied Change” shows the target side and file before it runs.

- “Return to the State Before Copy” replaces the current full text with the exact pre-copy text recorded by the extension. It does not invoke generic Undo. The current full text must exactly match the recorded post-copy text; a document-version-only change does not cause a false failure.
- “Close Without Reverting” does not run Undo and does not change the file content, dirty state, L/R selection, or comparison state.

Closing the confirmation with `Esc` or the window close control is handled exactly like “Close Without Reverting.”

`Ctrl+Z` is the standard VS Code/Cursor Undo command and runs immediately when pressed. The extension does not show its confirmation dialog for the standard shortcut. `Ctrl+Shift+Z` also runs immediately as standard Redo.

If you edit the file after the copy, the extension may no longer be able to revert only that copy safely. Review the standard editor history instead.


## Changes made by another operation

If a compared file appears to have been changed by another application, another window, a Git operation, or a generation process, the extension stops comparison actions and does not use stale diff information.

The confirmation offers these choices:

- “Refresh the Comparison with the Current Content” rebuilds the diff from the current file content.
- “Close” keeps the file, comparison tab, and L/R unchanged while copy actions remain safely stopped.

Closing the dialog with `Esc` or the window close control never ends the comparison automatically. The comparison stays safely stopped and can be refreshed later from the warning in the L/R view.

Copies made by this extension, the extension’s revert action, `Ctrl+Z`, `Ctrl+Shift+Z`, and normal saves are not treated as changes made by another operation.

## What save means

Save writes the current unsaved editor content to the real file. After saving, the change remains even after VS Code/Cursor is closed.

After an extension copy, the target side shows an unsaved status. Save it by one of these methods:

1. Click “Save Changes to the L (Left) File” or “Save Changes to the R (Right) File” in the L/R view.
2. Click the side you want to save and press `Ctrl+S`.
3. Use File → Save.

For first-time use, prefer the extension’s side-specific save item because it confirms the exact target. Choosing “Do Not Save” does not write to the file. If Auto Save is enabled, the editor may save automatically after the copy.

## Swapping L and R

When L and R are swapped during a comparison, the extension closes the managed old diff tab and replaces it with one reversed diff tab. It does not leave a second comparison tab open.

## Normal and read-only modes

- Normal comparison: diff review, L/R copy commands, and standard editing are available.
- Read-only comparison: review only; L/R copy and real-file editing are disabled.

The L/R view and context menu show either “Current: Normal Comparison | Switch to Read-only” or “Current: Read-only | Switch to Normal Comparison.” File size or encoding safety checks may force read-only mode.

## Recent comparisons

“Recent Comparisons” reopens a previous L/R pair. The default limit is five. A pair cannot reopen if a file was moved or deleted.

## Recovery history for files outside Git

Before copying, saving, or restoring a file that is not managed by Git, the extension stores the previous content in extension-local storage.

Limits:

- Three newest records per file
- Thirty records in total
- 60 MB total

Older records beyond these limits are removed automatically, so routine cleanup is not required for capacity management.

Recovery History offers these direct actions:

- Compare with Current Content: opens a read-only comparison of the selected history entry and the current content captured when the comparison was opened.
- Restore This History Entry: keeps the current content as a new recovery-history entry, then replaces the editor content.
- Save as Another File: writes the history content to a new file without changing the current file.
- Delete This History Entry or delete all history.

The comparison guidance and its context menu both provide restore and save-as actions. Opening or closing the comparison does not modify or save a file. Restoring does not trigger a save from this extension. With Auto Save off, review and save manually; with Auto Save on, the restored content may be saved automatically afterward. Deleting all history does not delete or modify the original/current files.

Recovery data is never transmitted, but it is not encrypted in local storage.

## Closing the diff

Closing the managed diff tab automatically clears L/R and the Explorer decorations. Use Recent Comparisons to reopen the pair later.

## Troubleshooting

- Context menu missing: right-click a file, not a folder, in the Explorer.
- L/R unclear: check the L/R view, diff title, and full-address dialog.
- Copy commands missing: switch from read-only to normal mode when allowed.
- Active side not changing: move the text caret or scroll on the intended diff side.
- VS Code/Cursor differences: labels and order may vary slightly by base version, language, theme, and installed extensions.


The recorded pre-copy state is retained across Save and Auto Save. Restoring after a save places the pre-copy content back into the document; it may then be saved again according to your VS Code/Cursor settings.



## Access all actions from the context menu

Right-click a managed diff editor and open `Easy Left Right Diff` to access copy, save, swap, open L/R files, reveal locations, history, recovery-history, and help actions.

Choose `Open Left/Right Control Menu (All Items)` to focus the full control view. If Explorer L/R colors are missing, use `Check or Enable Explorer L/R Colors`; settings are changed only after confirmation.

### Selection note

This command is convenient when two files are easy to select together, such as in the same folder.

If selection does not work or the files are in different folders, use the reliable one-file-at-a-time method: set the first file as L / Left, then set the second file as R / Right and compare.

### Recovery history for this file

The extension creates recovery history before its own copy, save, and restore operations whether or not the target file is tracked by Git. The unmanaged-file warning is a separate safety notice and does not control history creation.

Right-click a regular file and choose `Easy Left Right Diff` → `Open Recovery History for This File` to show only entries for that file. The view contains only recovery history automatically saved by this extension; it does not show Git history, VS Code history, or changes not saved by this extension.

`Show Target File Information` displays the file name, full path, workspace, current existence, unsaved-change state, and the selected history entry's creation time and reason. After restoration, use `Open Pre-Restoration History` to compare the automatically saved pre-restoration state before restoring it. Auto Save guidance distinguishes Off, After Delay, Editor Focus Change, and Window Focus Change.


When changes made with this extension are saved to a Git-managed file, Git shows them as ordinary file changes. Discarding changes in Git may also discard other uncommitted edits that were not made by this extension.

## Recovery history after move, deletion, or replacement

Recovery history follows files and parent folders moved or renamed through VS Code/Cursor. If the target is deleted, another file is created at the same address, or the saved target identity no longer matches, the old history is detached as “target file unavailable.” It cannot restore directly to a current file, but Save As remains available.

The right side of a recovery comparison is the content captured when the comparison was opened. Restore, entry deletion, and delete-all close the corresponding stale recovery comparison tabs.
