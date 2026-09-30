# Authoring SatelliteT3 review documents

The document API preserves reviewed content independently of a provider's working
files and session history. Publish self-contained HTML, Markdown, or text using
the thread-scoped `publish_document` tool. Supply a unique `requestId`, `title`,
`kind` (`plan`, `review`, or `document`), and the absolute host `path`. For a
checklist, include `definition: { items: [{ id, title, description? }] }`. Item IDs
must remain stable within a revision. Publishing does not approve anything.

`list_documents` returns the current revision IDs for this thread;
`read_document` returns retained content, its checklist, draft answers, and the
last submission. To replace a document, publish with its `documentId` and
`expectedCurrentRevisionId`. Keep the same publication request ID and payload
when recovering an uncertain request. A replacement creates a new retained
revision and resets its answers.

The server owns the published snapshots below its configured `userdata/documents`
directory, and metadata, answer history, and submission receipts in its SQLite
database. Do not edit that storage directly or assume it lives on the client
machine. For the isolated development launcher the data directory is
`<checkout>/.t3/satellite/userdata`.

## A working checklist example

The example generator creates a self-contained document from a checklist:

```powershell
node scripts/create-review-document.mjs examples/documents/manual-verification.json .t3/verification/manual-review.html
```

It refuses to overwrite an existing output. Publish that file with `kind: "review"`
and the example JSON's `items` in `definition`. A coding agent can do this using
the built-in document tools. The HTML supports standalone Markdown export;
inside SatelliteT3 it saves through the bridge and leaves submission and export
to the host controls.

To adapt a document-generation skill, retain its visual layout and item controls,
embed the small client in
[`examples/documents/satellite-document.js`](../../examples/documents/satellite-document.js),
and pass the checklist values to `saveDraft`. The generator shows how to inline
the client without external scripts or build dependencies. Custom HTML and the
native checklist must use the same registered item IDs.

## JSON bridge

Web/desktop use messages between the sandboxed document frame and its parent;
mobile uses the WebView message bridge. Both carry the same `t3-document-v1`
protocol. The host binds the frame to one document and revision; document HTML
does not receive T3 credentials or arbitrary filesystem access.

The page announces `{ "protocol": "t3-document-v1", "type": "ready" }`. The host
replies with `type: "init"`, a `sessionId`, `documentId`, `revisionId`, `readOnly`,
`expectedAnswerRevision`, `definition`, and `result: { answers: [...] }`.

A save request has this shape:

```json
{
  "protocol": "t3-document-v1",
  "type": "request",
  "sessionId": "from-host",
  "documentId": "from-host",
  "revisionId": "from-host",
  "requestId": "unique-save-id",
  "method": "saveDraft",
  "expectedAnswerRevision": 3,
  "result": {
    "answers": [{ "itemId": "hide-window", "outcome": "broken", "notes": "The pill disappeared." }]
  }
}
```

Outcomes are `pending`, `complete`, `broken`, `change_requested`, and `skipped`.
`load` is the other supported method and does not require answers. A response
echoes the bound IDs and request ID, with `type: "response"`, `ok`, and either
the saved `result`/`expectedAnswerRevision`/`readOnly`, or `error`.

Keep edits until a successful acknowledgement. A missing acknowledgement is not
proof that a save failed: load and reconcile before creating another request.
Conflicts do not grant permission to silently replace answers from another
device. Duplicate initialization messages must not overwrite unsaved page state.

The page cannot submit a review or approve agent work. Submission is an explicit
action in the surrounding app. A persisted submission and delivery to a provider
are separate facts: retries reuse the original result. An uncertain delivery keeps
its orchestration command identity; a confirmed rejection permits a new delivery
attempt. This keeps the audit trail intact without starting duplicate turns when a
connection drops after the server accepts the review.
