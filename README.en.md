# Easy Left Right Diff

A VS Code/Cursor extension that uses the standard diff editor while keeping the real L (left) and R (right) files, locations, active side, copy direction, and changed file clear.

Version `1.0.5` is the formal release. Windows Visual Studio Code and Cursor are the formally verified targets.

## Why use it

- Keep L/Left and R/Right clear even when file names are similar
- Copy the current changed block or a whole file in either direction with explicit source/target confirmation
- Keep local recovery history before the extension changes file contents
- Continue using the standard VS Code diff editor

## Screenshots

### Comparison overview

![Standard VS Code diff with Japanese files assigned to L/Left and R/Right](https://raw.githubusercontent.com/kantan-tools/easy-left-right-diff/main/images/marketplace/01-comparison-overview.png)

The extension keeps L/Left and R/Right visible while using the standard VS Code diff editor.

### Context menu

![Easy Left Right Diff context menu](https://raw.githubusercontent.com/kantan-tools/easy-left-right-diff/main/images/marketplace/02-context-menu.png)

Open copy, swap, Difference Summary, file information, and recovery-history actions directly from the managed comparison.

### Difference Summary

![Difference Summary showing one changed, one added, and one deleted hunk](https://raw.githubusercontent.com/kantan-tools/easy-left-right-diff/main/images/marketplace/03-difference-summary.png)

See the total and type of differences and jump directly to the selected hunk.

## Shortest three-step workflow

1. Right-click the first file and set it as L (Left).
2. Right-click the second file and set it as R (Right) and compare.
3. Confirm both files and start a normal or read-only comparison.

The numbered guidance in the L/R confirmation view can also open file pickers.

## Compare two files selected together

Use either route:

- Right-click one file → `Easy Left Right Diff` → `Compare Two Selected Files as L and R`. A clear confirmation states that the right-clicked file is already the first file; the following file picker is only for the second file.
- Select two files in Explorer with `Ctrl`, then right-click → `Easy Left Right Diff` → `Choose Two Files and Compare`.
- Click `Or: choose two files and compare them together` in the L/R confirmation view.

Selection order does not decide L and R. After choosing two files, explicitly choose which file is L / Left and confirm both sides before the comparison starts.

## Main features

- L/R selection from the file context menu or confirmation view
- Step-by-step 1/2/3 guidance
- One confirmation screen for L/R and comparison mode
- Standard VS Code diff editor
- Strong L/R boundaries in the diff title
- Same-name file location identification and full-address dialog
- L/R confirmation view plus blue L / purple R Explorer colors and L/R badges
- Active-side detection from text-caret movement and scrolling
- Bidirectional current-change and whole-file copy
- Clear source, destination, and real target-file confirmation
- Side-specific confirmation before restoring the last extension copy from its recorded pre-copy content
- Side-specific save actions for unsaved L/R content, plus standard `Ctrl+S` support
- Safety checks for unsaved state, auto save, Git status, size, and encoding
- Recent comparison history
- Recovery history
- Individual and delete-all recovery-history cleanup
- Automatic L/R clearing when the managed diff tab closes
- Bundled Usage and Troubleshooting guide

## Usage and Troubleshooting

Open `Usage and Troubleshooting` from the L/R confirmation view or Command Palette. The VSIX contains `USAGE.md` and `USAGE.en.md`; the extension selects the guide according to the editor language.

## Recovery history

Before the extension changes a file by copying, saving, or restoring, it automatically stores the current content in extension-local recovery history, whether or not the file is tracked by Git. The unmanaged-file warning and recovery-history creation are separate safeguards. The history list can compare it with current content, restore it, save it as another file, or delete it.

Limits:

- Three newest records per file
- Thirty records in total
- 60 MB total

Older records beyond the limits are removed automatically. Users may delete one entry or all entries. Delete-all does not delete or modify original/current files.

The recovery comparison is read-only on both sides. Opening or closing it does not modify or save a file. When restoring a history entry, the extension itself does not perform a save. With Auto Save off, review and save manually. With Auto Save on, the restored content may be saved automatically afterward.

When a file or parent folder is moved or renamed through VS Code/Cursor, recovery history follows the new address. History is detached when its target is deleted, when another file is created at the same address, or when the saved target identity no longer matches. Detached history cannot restore directly to a current file, but it can still be saved as another file. The right side of a recovery comparison is explicitly the content captured when that comparison was opened. Restore and history deletion close the corresponding comparison tabs and release their temporary content.

- Save or Auto Save does not discard the recorded pre-copy state. If the current text still matches the copy result, the extension can restore the recorded pre-copy text.

## Privacy

Product features make no network requests and do not transmit file contents or diffs. There is no telemetry, AI service, or account registration.

Recent comparisons store L/R paths locally. Recovery-history entries store file contents locally and are not encrypted. See `PRIVACY.md` for details.

## Checked environments

- Visual Studio Code: Windows verification target
- Cursor: Windows verification target
- macOS: not yet verified
- Linux: not yet verified

## Known limitations

- The first formally verified targets are Windows VS Code and Cursor. macOS and Linux are not yet verified.
- Runtime messages, confirmations, the L/R view, status display, and errors are localized for Japanese and English. Other editor languages use the Japanese fallback catalog.
- The extension does not use private diff-editor APIs. It stops when one unique change cannot be identified safely.
- Recovery history is local and not encrypted.
- Files outside the workspace open in a normal editor rather than being added to the standard Explorer tree.
- The publisher ID, public repository, issue tracker, private security reporting route, license holder, icon, and listing images are finalized release information.

## Publication status

Version `1.0.5` is the formal release. Windows Visual Studio Code and Cursor are the formally verified targets; macOS and Linux are not yet verified. Version 1.0.5 pins Marketplace screenshot links to absolute public GitHub URLs so the packaged README remains byte-identical to the inspected source. Comparison, copy, save, recovery, and other runtime code is unchanged from 1.0.3.


When changes made with this extension are saved to a Git-managed file, Git shows them as ordinary file changes. Discarding changes in Git may also discard other uncommitted edits that were not made by this extension.
