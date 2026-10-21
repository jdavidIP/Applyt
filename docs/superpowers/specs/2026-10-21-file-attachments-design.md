# Attach Your Own Resume / Cover Letter Files — Design

**Date:** 2026-10-21
**Status:** Draft, awaiting review

## Intent

A user who already has their own resume or cover-letter design should be able to make the file however they like and keep **that exact file** with an application in Applyt. Applyt must not reformat it.

The trigger: Claude Desktop, asked to tailor a resume through the Applyt MCP server, built a polished PDF in its own workspace. That PDF looked the way the user wanted. But what Applyt stored was the structured JSON from `save_tailored_resume`, which downloads through Applyt's ATS template, so the file the user actually liked was not what Applyt kept.

## Decisions (made by the user)

- **Exact files.** Uploaded files are stored and downloaded back unchanged.
- **Two ways in, both required:**
  - an MCP tool that attaches files from paths on the user's machine;
  - an upload option in the dashboard, for files made without Claude.
- **Stored as a resume version.** An attached set becomes one entry in the application's existing version list. On that version, the PDF and Word download buttons return the attached files.
- **Cover letters.** An attached cover letter gets its own download. Generated (structured) cover letters still get **no** download, as today.
- **Storage.** Files are stored inside the SQLite database, in their own table.
- **Template unchanged elsewhere.** The ATS template keeps applying to the dashboard's Tailor button and to MCP `save_tailored_resume`.

## Goals

- **What a file version holds:** a resume, a cover letter, or both, each as a PDF and/or a Word (`.docx`) file. At most one file per (kind, format), so at most 4 files.
- **Downloads are byte-identical** to what was attached, with the original filename.
- **Previews:** the dashboard preview, the extension popup and the MCP `get_application` tool can still show the text of an attached resume.
- **Desktop path:** a Claude Desktop user can download the file Claude made, then say "attach `C:\…\resume.pdf` to application 12" and be done.

## Non-goals

- **No format conversion.** Applyt doesn't turn PDF into DOCX or the other way round. A version with only a PDF has no Word download.
- **No transfer straight from Claude Desktop's workspace.** Files Desktop builds live in Anthropic's sandbox, which the local MCP server can't reach. Sending a file as base64 through a tool call was considered and rejected: a 57 KB PDF becomes about 76k characters, which is slow and costly, and one wrong character corrupts the file.
- **No editing, renaming or replacing** files on an existing version. To change a file, attach a new version.
- **No download for generated cover letters.**
- **No storage outside SQLite** (no files folder, no cloud).

## Anti-goals (would make this a failure even if it "works")

- Any change to the bytes of an attached file: re-encoding, re-rendering, stripping metadata.
- File bytes stored in `resume_versions` or returned by any list query. Listing versions must stay as cheap as it is today.
- The MCP tool being usable to pull arbitrary files off the user's disk, for example an SSH key, if Claude is confused or manipulated.

## Constraints

- **CLAUDE.md §2: one storage path.**
  - The MCP tool reads the file from disk and uploads it through the backend's HTTP API.
  - The MCP server never writes to SQLite.
  - The dashboard uploads through the same backend route.
- **No new dependencies.** Applyt already has:
  - `@fastify/multipart`, currently registered only inside the settings plugin;
  - `pdf-parse` and `mammoth`, via `backend/src/resume/resumeExtract.ts`;
  - Node ≥ 20, which has global `FormData` and `Blob` for the MCP side.
- **Deletes:** the schema has no `ON DELETE CASCADE`. The shared `deleteApplicationsCascade` helper in `backend/src/routes/applications.ts` must delete the new table's rows first.
- **Mirrored files:** `resumeSchema.ts` and `tailoredResume.ts` are mirrored across backend, dashboard and extension, and enforced by `backend/test/mirror-sync.test.ts`. Avoid changing them if possible; any change must land in all three copies.

## Design

### Data

New table, added with the existing additive-migration pattern in `backend/src/storage/`:

```sql
CREATE TABLE IF NOT EXISTS resume_version_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resume_version_id INTEGER NOT NULL REFERENCES resume_versions(id),
  kind TEXT NOT NULL,          -- 'resume' | 'cover_letter'
  format TEXT NOT NULL,        -- 'pdf' | 'docx'
  filename TEXT NOT NULL,      -- original name, used on download
  size INTEGER NOT NULL,       -- bytes
  data BLOB NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (resume_version_id, kind, format)
);
```

The version row itself (`resume_versions`) for an attached set:

| Column | Value |
|---|---|
| `ai_provider` | `'file'` |
| `tailored_output` | Plain text extracted from the resume file: the PDF if there is one, otherwise the DOCX. If only a cover letter was attached, use the cover letter's text. Stored as flat text, so the existing legacy fallback in `parseTailoredResume` shows it in every preview (dashboard, extension popup) with **no change to the mirrored parser**. |
| `base_resume_snapshot`, `model`, `input_tokens`, `output_tokens`, `cost`, `input_char_length` | `NULL` |

If text extraction fails (for example a scanned PDF), store a short placeholder line instead and still accept the upload. Extraction is only for previews, and the file itself is what matters.

### Backend routes

1. **`POST /applications/:id/resume-versions/files`** (multipart).
   - **Fields:** up to 4 file parts named `resume` or `cover_letter`.
   - **Format detection** comes from the file's leading bytes, never from the extension or the client-sent MIME type:
     - `%PDF-` → pdf;
     - a ZIP header (`PK\x03\x04`) whose archive contains `word/document.xml` → docx.
   - **Limit:** 5 MB per file.
   - **Responses:**
     - 404: unknown application.
     - 400: no files, an unknown field name, an unsupported type, or two files with the same kind and format.
     - 413: a file is too large.
   - **Writes:** the version row and all its file rows in **one transaction**. It also bumps the application's `updated_at`, as the other version-creating routes do.
   - **Returns:** 201 with the version row plus its `files` summary (see 3).
2. **Existing `GET /applications/:id/resume-versions/:versionId/download`** gains an optional `kind` query parameter, `resume` (default) or `cover_letter`.
   - **File versions:**
     - `format=pdf|docx` serves the stored file of that kind and format, unchanged, with `Content-Disposition` set to the original filename. If no such file exists, it returns 404 naming the missing file ("This version has no Word resume").
     - `format=txt` returns the extracted text.
   - **Other versions:** behaviour is unchanged. `kind=cover_letter` returns 404, because generated cover letters stay without a download.
3. **Existing `GET /applications/:id/resume-versions`:** each version gains `files: { kind, format, filename, size }[]`. This is an empty array for non-file versions, read with a join or a second query that selects **no `data` column**.
4. **Deletes:** `deleteApplicationsCascade` deletes `resume_version_files` (via the versions of those applications) before `resume_versions`.

### MCP tool: `attach_files`

- **Input:** `applicationId`, and `files`: 1–4 entries of `{ path, kind: 'resume' | 'cover_letter' }`.
- **Annotations:** not read-only, not destructive, since it adds a version.
- **Description:** explains when to use it:
  - the user made the file themselves, in Claude Desktop or elsewhere;
  - Desktop users must download the file first and give its path.

  It also says this tool is the alternative to `save_tailored_resume` when the user wants their own layout kept.
- **Guard, per file, before reading the contents:**
  - the path must be absolute;
  - the extension must be `.pdf` or `.docx`;
  - `stat` must show a regular file of at most 5 MB.

  Then it reads the file and checks the same leading bytes the backend checks. Any failure → a tool error naming the file and reason, and nothing is uploaded.
- **Upload:** the files go to route 1 as multipart. Returns the new version id and a pointer to the dashboard.
- **Client:** `mcp/src/client.ts` needs to send a multipart body as well as JSON. Keep it the single place that does network I/O, with the same error handling.
- **`get_application`'s version summary:** already shows `ai_provider`. It should also list each version's `files` (kind, format, filename) so Claude can tell the user what's attached.

### Dashboard (in `TailorModal`, the per-application tailoring/version view)

- **"Upload files" control:**
  - Lets the user pick a resume and/or cover letter file and posts to route 1.
  - Must work even when the application has **no job description**. Today the Tailor button is disabled in that case; uploading must not be.
- **Version chip:** a file version's chip reads `file · <date>`, which comes free from `ai_provider`.
- **Selected file version:**
  - **Resume downloads:** PDF / Word buttons are enabled only for the formats that were attached. TXT works.
  - **Cover letter downloads:** a cover letter download (PDF and/or Word, per what was attached) appears only on file versions.
  - **Usage/cost meta line:** must not suggest a paid AI run. It should show nothing, or "Uploaded file".
- **Types:** the dashboard's `ResumeVersion` type gains `files`.

### Extension popup

No change required. The popup lists versions and offers PDF/DOCX/TXT downloads:
- for file versions, available formats download the attached file;
- missing formats get the backend's 404 message through the popup's existing error display.

### Traps to cover (from the builder check; resolutions are design-author calls)

- **nginx under Docker:**
  - **Problem:** `dashboard/nginx.conf` proxies `/api/` with no `client_max_body_size`. nginx defaults that to 1 MB, so any upload over 1 MB gets an nginx 413 before reaching the backend. The existing 10 MB base-resume upload has the same bug today.
  - **Fix:** set `client_max_body_size` on the `/api/` location to cover both routes, for example `12m`, since a multipart request is slightly bigger than its files.
- **Download filenames:**
  - **Problem:** both clients ignore `Content-Disposition` and build `company-title-resume.<ext>` themselves: `TailorModal.tsx` (`handleDownload`) and `extension/src/popup/main.ts`.
  - **Dashboard:** for file versions, the modal must name the download from `files[].filename`.
  - **Extension popup:** stays as it is and keeps its generated name. The bytes are still identical. *(design-author call)*
- **Word detection without a new dependency:**
  - **Backend (authoritative):** confirms a `.docx` by checking for the ZIP header `PK\x03\x04` and then scanning the archive's file list for an entry named `word/document.xml`. A small hand-written check is enough.
  - **MCP side:** checks only the leading bytes (`%PDF-` or `PK\x03\x04`) together with the extension and leaves the full check to the backend. That avoids a second copy of the archive scan, since there's no shared package. *(design-author call)*

## Testing expectations

- **Backend:**
  - an upload round-trips **byte-identical**: hash in equals hash out, for both PDF and DOCX;
  - original filename in `Content-Disposition`;
  - format detected from content, so a `.pdf` file that's really text is rejected;
  - 5 MB limit gives 413;
  - duplicate kind+format gives 400;
  - unknown application gives 404;
  - cover-letter-only upload works;
  - missing format gives 404;
  - `kind=cover_letter` on a generated version gives 404;
  - list responses never contain blob data;
  - deleting an application with file versions succeeds (FK);
  - extraction failure still saves.
- **MCP:**
  - path guard: relative path, wrong extension, oversized file, directory, and right extension with wrong content are all rejected before upload;
  - a valid attach posts the right multipart parts.
- **Dashboard:** download buttons reflect the available formats; upload works without a job description.
- **Manual:**
  - attach the real Claude-Desktop PDF via MCP, then download it from the dashboard and confirm it's identical;
  - upload through the dashboard;
  - delete the application.

## Left to the builder

- The migration's exact placement and the multipart registration scope: per plugin, or at app level, as long as the settings route's 10 MB limit is unaffected.
- The exact upload UI: one picker with a kind selector, or two pickers. Keep it simple and in the existing visual style.
- Placeholder wording for un-extractable text; error message wording.
- Whether `kind`/`format` get SQL `CHECK` constraints, in addition to validation in code.
- Docs: README feature bullet and API table rows, SETUP's MCP section, ARCHITECTURE's backend/MCP notes. CLAUDE.md §5 only if the schema listing there is meant to stay complete.
