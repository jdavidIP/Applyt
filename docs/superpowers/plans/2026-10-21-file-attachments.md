# Attach Your Own Resume / Cover Letter Files — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users can attach their own PDF/DOCX resume and/or cover letter to an application, from the MCP server or the dashboard. The files are stored as a "file" resume version and download back byte for byte.

**Architecture:**
- **Storage:** a new `resume_version_files` table holds the bytes (BLOB), separate from `resume_versions`, so list queries never touch them.
- **Backend:** one multipart route creates a version plus its files in a single transaction. The existing download route serves stored files for file versions.
- **MCP server:** a new `attach_files` tool reads files from local paths, after a path/extension/size/leading-bytes guard, and posts them to that route.
- **Dashboard:** `TailorModal` gets an upload control, per-format download availability, cover-letter downloads, and original filenames.

**Tech Stack:** Fastify + `@fastify/multipart` + better-sqlite3 (backend); `@modelcontextprotocol/server` + zod (mcp); React + Vite (dashboard); `node:test` via tsx, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-21-file-attachments-design.md`

## Global Constraints

- **Branch:** `feat/file-attachments`. Never commit to `main`.
- **Commits** (`CLAUDE_WORKFLOW.md`):
  - Confirm every commit with the user before making it, one commit at a time.
  - **No `Co-Authored-By` trailer and no "Generated with Claude Code" text anywhere.**
- **No new dependencies** in any workspace.
- **Byte-for-byte:** attached files are never re-encoded or re-rendered.
- **Format:** decided by the file's leading bytes, never by extension or client MIME type.
  - PDF: starts with `%PDF-`.
  - DOCX: starts with `PK\x03\x04` and the archive's file list contains an entry named `word/document.xml`.
- **Limits:** 5 MB per file (`5 * 1024 * 1024`). At most 4 files per version, and at most one per (kind, format).
  - Kinds: `'resume' | 'cover_letter'`.
  - Formats: `'pdf' | 'docx'`.
- **Version row** for an attached set:
  - `ai_provider = 'file'`;
  - `model`, `input_tokens`, `output_tokens`, `cost`, `input_char_length` and `base_resume_snapshot` all `NULL`.
- **`tailored_output`:** extracted plain text, taken from the resume PDF, else the resume DOCX, else the cover letter's PDF or DOCX.
  - On extraction failure, store `(Text could not be extracted from this file.)` and still save.
- **Untouched files:** the mirrored `resumeSchema.ts` / `tailoredResume.ts` files must not change (`backend/test/mirror-sync.test.ts`).
- **Generated versions keep current download behaviour.** `kind=cover_letter` on a non-file version → 404.
- **Source imports** use `.js` extensions; test files import sources with `.ts` (repo convention).

## Review Focus

1. **Non-ASCII / quoted original filename** (e.g. `José "CV".pdf`) → download still works. `Content-Disposition` carries an ASCII-safe `filename=` plus `filename*=UTF-8''…`, and never throws or splits the header. *(Task 2)*
2. **Empty (0-byte) file** → 400 `"<field> file is empty"`, not a stored empty version. *(Task 1; MCP also rejects it in Task 3)*
3. **A ZIP that isn't a Word document** (`.xlsx` renamed `.docx`) → 400 unsupported type. Both start with `PK\x03\x04`, so a header-only check would let it through. *(Task 1)*
4. **Windows path with spaces, or a `~/…` path** handed to `attach_files`:
   - `C:\Users\Me\My Resume.pdf` works;
   - `~/resume.pdf` is rejected as not absolute, with a message telling Claude to give the full path.

   *(Task 3)*
5. **The full allowance of 4 × 5 MB in one upload** → accepted by the backend multipart limits *and* by nginx, which must allow ≥ 21 MB, so set `25m`. The spec's example of `12m` would block a legitimate 4-file upload. *(Task 1 backend test; nginx value in Task 4)*

---

### Task 1: Storage, format detection and the upload route

**Files:**
- Modify: `backend/src/storage/schema.ts`: add the `resume_version_files` table (spec DDL) to `SCHEMA_SQL`. `CREATE TABLE IF NOT EXISTS` makes it apply to existing DBs; no `migrate()` step needed.
- Create: `backend/src/resume/fileFormat.ts`
- Modify: `backend/src/routes/applications.ts`:
  - register multipart in this plugin;
  - `deleteApplicationsCascade`;
  - new route;
  - list route adds `files`.
- Modify: `backend/src/types/index.ts`: add `ATTACHMENT_KINDS`, `ATTACHMENT_FORMATS`, `ResumeVersionFileSummary`, `ResumeVersionWithFiles`.
- Test: `backend/test/file-attachments.test.ts` (new; copy the `multipartPayload` / `makeFixturePdf` / `makeFixtureDocx` helpers from `backend/test/resume-file-io.test.ts`, generalised to several named parts).

**Interfaces:**
- Produces, in `fileFormat.ts`:
  - `detectFileFormat(buf: Buffer): 'pdf' | 'docx' | null`;
  - `MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024`;
  - `FORMAT_MIME: Record<'pdf' | 'docx', string>` (`application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`).
- Produces, in `types/index.ts`:
  - `ATTACHMENT_KINDS = ['resume', 'cover_letter'] as const`;
  - `ATTACHMENT_FORMATS = ['pdf', 'docx'] as const`;
  - `type AttachmentKind = (typeof ATTACHMENT_KINDS)[number]` and `type AttachmentFormat = (typeof ATTACHMENT_FORMATS)[number]`;
  - `interface ResumeVersionFileSummary { kind: AttachmentKind; format: AttachmentFormat; filename: string; size: number }`;
  - `interface ResumeVersionWithFiles extends ResumeVersion { files: ResumeVersionFileSummary[] }`.
- Produces, as routes:
  - `POST /applications/:id/resume-versions/files` (multipart, parts named `resume` or `cover_letter`) → 201 `ResumeVersionWithFiles`;
  - `GET /applications/:id/resume-versions` now returns `ResumeVersionWithFiles[]`, with `files: []` for generated versions.

- [x] **Step 1: Write failing tests** in `backend/test/file-attachments.test.ts`, using the same app/DB setup pattern as `resume-file-io.test.ts`:
  - `detectFileFormat` returns `'pdf'` for a pdfkit fixture and `'docx'` for a `docx` fixture.
  - It returns `null` for:
    - plain text;
    - a ZIP without `word/document.xml`. Build it by taking the docx fixture and replacing every `word/document.xml` byte sequence with `word/documenX.xml` of the same length.
  - `upload round-trips a PDF and DOCX resume plus a PDF cover letter`:
    - responds 201;
    - `ai_provider === 'file'`, `cost === null`;
    - `files` has 3 entries with their `filename`s and `size`s;
    - `tailored_output` contains the PDF fixture's text.
  - `list returns files without blob data`: `JSON.stringify(list)` does not contain `"data"`, and the generated version from `/tailor` or `/resume-versions` has `files: []`.
  - `cover-letter-only upload is accepted`.
  - Rejections, with nothing written (version count unchanged):
    - no file parts → 400;
    - a part named `photo` → 400;
    - a text file named `x.pdf` → 400 unsupported type;
    - two `resume` PDFs → 400 duplicate;
    - a 0-byte file → 400 `/empty/`;
    - a 5 MB + 1 byte PDF (fixture padded with trailing bytes) → 413;
    - unknown application → 404.
  - `four files of 5 MB each are accepted`: pad the fixtures to exactly 5 MB. Trailing bytes after `%%EOF` are fine for detection.
  - `extraction failure still saves with placeholder`: a buffer starting with `%PDF-` followed by garbage → 201, `tailored_output === '(Text could not be extracted from this file.)'`.
  - `deleting an application with a file version succeeds`: `DELETE /applications/:id` → 204, and the `resume_version_files` row count for it is 0.

- [x] **Step 2: Run tests to verify they fail**

  Run: `npm test --workspace backend`
  Expected: the new file fails (module/route missing); every existing test passes.

- [x] **Step 3: Implement `fileFormat.ts`.** The DOCX check needs a ZIP file-list scan, since there's no zip library:

  ```ts
  // Walk local file headers (sig 0x04034b50): name length at +26, extra length at +28,
  // compressed size at +18, name at +30. Stop on any other signature (central directory).
  // If a header has the data-descriptor flag (bit 3 of the flags at +6) the size is 0 —
  // fall back to `buf.includes('word/document.xml')` in that case.
  ```

- [x] **Step 4: Implement the route and wiring** in `applications.ts`:
  - **Multipart:** register `@fastify/multipart` in `applicationsRoutes` with `limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 4 }, throwFileSizeLimit: true`. Being a separate plugin, it doesn't affect the settings route's 10 MB / 1-file registration.
  - **Reading:** iterate `request.parts()`. Validate each part:
    - field name in `ATTACHMENT_KINDS`;
    - non-empty;
    - `detectFileFormat` not null;
    - no duplicate (kind, format).
  - **Writing:** do it all in one `db.transaction`:
    - insert the `resume_versions` row (values per Global Constraints);
    - insert the file rows;
    - bump `applications.updated_at`.
  - **Text extraction:** run it before the transaction, with the existing `extractResumeText(buffer, FORMAT_MIME[format])`, wrapped in try/catch → placeholder.
  - **Too large:** map `fastify.multipartErrors.RequestFileTooLargeError` → 413 `File is too large (max 5MB).`.
  - **List route:** after selecting versions, run one query `SELECT resume_version_id, kind, format, filename, size FROM resume_version_files WHERE resume_version_id IN (…)` (never `data`) and attach `files`.
  - **Cascade:** in `deleteApplicationsCascade`, first `DELETE FROM resume_version_files WHERE resume_version_id IN (SELECT id FROM resume_versions WHERE application_id IN (…))`.

- [x] **Step 5: Run tests to verify they pass**

  Run: `npm test --workspace backend`
  Expected: all pass, including `mirror-sync`.

- [x] **Step 6: Commit (after the user confirms)**

  ```bash
  git add backend/src/storage/schema.ts backend/src/resume/fileFormat.ts backend/src/routes/applications.ts backend/src/types/index.ts backend/test/file-attachments.test.ts
  git commit -m "Store attached resume/cover letter files as a file resume version"
  ```

---

### Task 2: Serving attached files from the download route

**Files:**
- Modify: `backend/src/routes/applications.ts` (the download route)
- Modify: `backend/src/validation.ts`: `resumeDownloadQuerySchema` gains optional `kind` (enum `ATTACHMENT_KINDS`, default `'resume'`).
- Test: `backend/test/file-attachments.test.ts`

**Interfaces:**
- Consumes: Task 1's table, `FORMAT_MIME`, `ATTACHMENT_KINDS`.
- Produces: `GET /applications/:id/resume-versions/:versionId/download?format=pdf|docx|txt&kind=resume|cover_letter`.
  - **File version:**
    - pdf/docx → the stored bytes, with `Content-Type` from `FORMAT_MIME` and the original filename in `Content-Disposition`;
    - missing file → 404 `{ error: "This version has no Word resume" }`, wording per kind/format;
    - txt → `tailored_output`.
  - **Generated version:** unchanged when `kind` is absent or `resume`; `kind=cover_letter` → 404.

- [x] **Step 1: Write failing tests**
  - `download returns the exact bytes`: `createHash('sha256')` of the uploaded buffer equals that of `res.rawPayload`, for PDF and DOCX. Check `content-type` too.
  - `download uses the original filename`: an upload named `Jose_Resume.pdf` gives a `content-disposition` that includes `filename="Jose_Resume.pdf"`.
  - `non-ASCII and quoted filename is encoded safely`: an upload named `José "CV".pdf` gives a 200 whose `content-disposition` matches `/filename\*=UTF-8''Jos%C3%A9%20%22CV%22\.pdf/` and contains no raw `"` inside the quoted `filename=` value.
  - `cover letter download` via `kind=cover_letter&format=pdf` returns the cover letter bytes.
  - `missing format → 404 naming it`: a PDF-only resume requested as `format=docx` gives 404 with `/no Word resume/`.
  - `txt on a file version returns extracted text`.
  - `kind=cover_letter on a generated version → 404`, using a version created via `POST /applications/:id/resume-versions` (the MCP save route).
  - `generated version downloads are unchanged`: the existing structured-version PDF download still returns 200 `application/pdf`.

- [x] **Step 2: Run to verify failure.** Run `npm test --workspace backend`. Expected: new tests FAIL (400 on the unknown `kind` query, or wrong bytes).

- [x] **Step 3: Implement.**
  - **Branch on `version.ai_provider === 'file'`** before the existing render path. Read one row: `SELECT filename, format, data FROM resume_version_files WHERE resume_version_id = ? AND kind = ? AND format = ?`.
  - **Filename header:** `attachment; filename="<ascii fallback>"; filename*=UTF-8''<encodeURIComponent(name)>`. In the ASCII fallback, replace non-ASCII characters and `"` `\` with `_`.
  - **Existing 404:** the `!version.tailored_output` 404 stays for generated versions only.

- [x] **Step 4: Run to verify pass.** Run `npm test --workspace backend`. Expected: all pass.

- [x] **Step 5: Commit (after the user confirms)**

  ```bash
  git add backend/src/routes/applications.ts backend/src/validation.ts backend/test/file-attachments.test.ts
  git commit -m "Serve attached files byte-for-byte from the version download route"
  ```

---

### Task 3: MCP `attach_files` tool

**Files:**
- Modify: `mcp/src/client.ts`: `request()` sends a `FormData` body as-is, without setting `content-type`, so fetch adds the boundary. The signature is unchanged.
- Create: `mcp/src/attachFiles.ts`: the path guard and read.
- Modify: `mcp/src/tools.ts`: the `attach_files` tool; `get_application` includes each version's `files`.
- Test: `mcp/test/attachFiles.test.ts` (new), `mcp/test/client.test.ts`, `mcp/test/tools.test.ts`

**Interfaces:**
- Consumes: the Task 1 route and `files` on list responses.
- Produces, in `attachFiles.ts`:
  - `readAttachment(path: string): Promise<{ filename: string; format: 'pdf' | 'docx'; data: Buffer }>`. It throws `Error` with a message naming the path and the reason.
  - Exports `MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024`. This is a deliberate literal copy of the backend constant; the workspaces share no package.
- Produces, the tool `attach_files`:
  - **Input:** `{ applicationId: int ≥ 1, files: { path: string, kind: 'resume' | 'cover_letter' }[] (1–4) }`.
  - **Annotations:** `{ readOnlyHint: false, destructiveHint: false }`.
  - **Description** must say:
    - use it when the user made the file themselves and wants their own layout kept (versus `save_tailored_resume`);
    - Claude Desktop users must download the file first and give its full path.

- [x] **Step 1: Write failing tests**
  - `attachFiles.test.ts`, using real temp files under `os.tmpdir()`:
    - accepts an absolute `.pdf` starting with `%PDF-`, including one in a directory whose name has a space (`My Docs/My Resume.pdf`);
    - accepts a `.docx` starting with `PK\x03\x04`.
    - Rejects:
      - a relative path → `/absolute/`;
      - `~/resume.pdf` → `/absolute/`;
      - `.txt` → `/\.pdf or \.docx/`;
      - a directory named `x.pdf` → `/not a file/`;
      - a 0-byte file → `/empty/`;
      - a file over 5 MB → `/5 MB/`;
      - `.pdf` with text content → `/not a PDF/`.
    - The size check runs before the full read: spy on `fs.promises.readFile` via `mock.method` and assert it is not called for the oversized case.
  - `client.test.ts`: `request sends FormData without a JSON content-type`. The stubbed fetch receives `init.body instanceof FormData`, and there is no `content-type` header.
  - `tools.test.ts`:
    - `attach_files posts parts named by kind`: temp files plus a stubbed `POST /applications/3/resume-versions/files` returning `{ id: 9, files: [...] }`. Assert the posted `FormData` has `resume` and `cover_letter` entries with the original filenames, and the text matches `/version 9/`.
    - `attach_files reports a guard failure as a tool error and posts nothing`.
    - `get_application lists files per version`.
    - The tool-count test changes to 10, and `attach_files` is not read-only.

- [x] **Step 2: Run to verify failure.** Run `npm test --workspace mcp`. Expected: new tests FAIL; the old ones pass apart from the tool count.

- [x] **Step 3: Implement**
  - **Guard order** in `readAttachment`: `isAbsolute` → extension (lowercased) → `fs.promises.stat` (`isFile()`, `size > 0`, `size ≤ MAX`) → `readFile` → leading bytes match the extension (`%PDF-` for `.pdf`, `PK\x03\x04` for `.docx`; the full DOCX check is the backend's).
  - **Tool:** reads all files first and fails before any upload if one fails. Then it builds `FormData` with `new Blob([data])` and `filename = basename(path)`.

- [x] **Step 4: Run to verify pass.** Run `npm test --workspace mcp && npm run build --workspace mcp`. Expected: pass, clean build.

- [x] **Step 5: Commit (after the user confirms)**

  ```bash
  git add mcp/src/client.ts mcp/src/attachFiles.ts mcp/src/tools.ts mcp/test/attachFiles.test.ts mcp/test/client.test.ts mcp/test/tools.test.ts
  git commit -m "Add attach_files MCP tool for user-made resume and cover letter files"
  ```

---

### Task 4: Dashboard upload, downloads, and nginx limit

**Files:**
- Modify: `dashboard/src/types/index.ts`: `ResumeVersion` gains `files: ResumeVersionFileSummary[]`, plus the kind/format types (mirroring the backend names).
- Modify: `dashboard/src/services/api.ts`:
  - `uploadResumeFiles`;
  - `downloadResumeVersion` gains an optional `kind`.
- Modify: `dashboard/src/components/TailorModal.tsx`
- Modify: `dashboard/nginx.conf`: `client_max_body_size 25m;` in `location /api/`.
- Test: `dashboard/src/services/api.test.ts`

**Interfaces:**
- Consumes: the Task 1 and Task 2 routes.
- Produces:
  - `api.uploadResumeFiles(applicationId: number, files: { kind: AttachmentKind; file: File }[]): Promise<ResumeVersion>`. Like `extractResumeText`, it bypasses `request()` so the browser sets the multipart boundary, and surfaces the backend `error` on failure.
  - `api.downloadResumeVersion(applicationId, versionId, format, kind: AttachmentKind = 'resume')`. It adds `&kind=cover_letter` only when not `'resume'`.

- [x] **Step 1: Write failing API tests** in `api.test.ts`, following the existing `extractResumeText` tests:
  - `uploadResumeFiles POSTs FormData with parts named by kind and no manual Content-Type`;
  - `uploadResumeFiles surfaces the backend error message`;
  - `downloadResumeVersion adds kind=cover_letter only when asked`.

- [x] **Step 2: Run to verify failure.** Run `npm test --workspace dashboard`. Expected: the 3 new tests FAIL.

- [x] **Step 3: Implement the API functions and types.** Run the tests again. Expected: PASS.

- [x] **Step 4: Implement the `TailorModal` changes.** There's no component test harness in this repo, so these are checked manually in Step 5.
  - **"Upload files" control:**
    - visible regardless of `hasJobDescription`;
    - two file inputs (Resume, Cover letter), each `accept=".pdf,.docx"` and `multiple` (a PDF and a DOCX);
    - an Upload button that sends each chosen file with its kind.
  - **After upload:** the new version is prepended to `versions` and selected, the same way `settleRun` does after a tailor run.
  - **For a selected file version (`ai_provider === 'file'`):**
    - PDF and Word buttons are enabled only if `files` has `kind:'resume'` in that format;
    - TXT always works;
    - a "Cover letter" row with PDF/Word buttons appears only when `files` has `cover_letter` entries;
    - downloads are named from the matching `files[].filename`;
    - the meta line shows `Uploaded file` instead of `usageSummary(...)`.
  - **Generated versions:** behaviour is unchanged.

- [x] **Step 5: Verify.**
  - Run `npm test --workspace dashboard && npm run build --workspace dashboard`. Expected: pass and build.
  - Then, with `npm run dev`, check in the browser:
    - upload a PDF + DOCX resume and a PDF cover letter on an application **without** a job description;
    - the version appears as `file · <date>` with `Uploaded file`;
    - the downloads keep their original names and the files open identically;
    - a PDF-only version has the Word button disabled;
    - a generated version still downloads through the template.

- [x] **Step 6: Commit (after the user confirms)**

  ```bash
  git add dashboard/src/types/index.ts dashboard/src/services/api.ts dashboard/src/services/api.test.ts dashboard/src/components/TailorModal.tsx dashboard/nginx.conf
  git commit -m "Upload and download attached resume/cover letter files in the dashboard"
  ```

---

### Task 5: Docs and end-to-end check

**Files:** `README.md`, `SETUP.md`, `ARCHITECTURE.md`, `docs/superpowers/plans/2026-10-21-file-attachments.md` (tick boxes)

- [ ] **Step 1: Update the docs.**
  - **README:**
    - a feature bullet;
    - a line in "Use Applyt from Claude (MCP)" about `attach_files` (download from Desktop first, then give the path);
    - API table rows for `POST /applications/:id/resume-versions/files` and the `kind` parameter on download.
  - **SETUP:** one sentence in the MCP section.
  - **ARCHITECTURE:**
    - the backend bullet: file versions, `resume_version_files`, why bytes live in their own table;
    - the MCP bullet: `attachFiles.ts`'s guard.

- [ ] **Step 2: Full verification.** Run `npm test && npm run build`. Expected: all workspaces pass and build.

- [ ] **Step 3: Manual end-to-end with the user (Claude Desktop).**
  - Rebuild `mcp`.
  - Quit Desktop fully, then reopen. Only the rebuild is needed; the config is already in place.
  - Ask Claude to attach `C:\Users\Ibapo\Downloads\Jose_David_Ibanez_Resume.pdf` to a real application.
  - In the dashboard, download it and compare hashes with the original: `certutil -hashfile <file> SHA256`.

- [ ] **Step 4: Commit (after the user confirms)**

  ```bash
  git add README.md SETUP.md ARCHITECTURE.md docs/superpowers/plans/2026-10-21-file-attachments.md
  git commit -m "Document attaching your own resume and cover letter files"
  ```

- [ ] **Step 5: Pre-PR gate.**
  - Run the `code-reviewer` agent over `main...feat/file-attachments`.
  - Only a clean verdict clears the PR. Otherwise show the findings and let the user decide (`CLAUDE_WORKFLOW.md`).
  - Push and open the PR only on an explicit request. The PR body has no self-credit.
