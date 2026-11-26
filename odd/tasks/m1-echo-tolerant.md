# Tolerant M1 echo match

The operator sometimes retouches the M1 in Instagram after copying it on `/prospects` (drops an opening «¡», changes a word). Today the echo enrolls only on an exact normalized SHA (`src/prospects.ts` handleEcho → `db.pendingM1Threads`), so a retouched M1 stays «M1 sin confirmar» and the lead's reply is invisible. Origin: agency-os `odd/tasks/instagram-copro-tone.md` S3.

## Specs

- S1 — User request verbatim: «si yo modifico un poco el mensaje, que no te dé problemas para interpretar que a esa persona se le ha respondido, que a veces retoco algunas cosas».
- S2 — Exact match keeps priority and behaviour (one exact pending match enrolls; several exact matches stay ambiguous → `m1_sin_confirmar`, unchanged).
- S3 — When no exact match: compare the echo with the stored `m1_copied_text` of every pending thread of that account (`state='m1_pendiente'`, `igsid IS NULL`, `m1_sha` not null). Compare in a loose form: NFC, lowercase, every char that is not a letter, digit or whitespace removed (so `¡ ¿ ! ? , . : ; « » " ' 🙂` and emojis vanish), whitespace collapsed. Similarity = 1 − word-level Levenshtein distance / max(word count). Enroll the best thread only when its similarity ≥ 0.8 AND it beats the second-best by ≥ 0.2; otherwise write nothing and keep the content-free `unmatched` log. Never log text, ids or handles.
- S4 — Fail closed: a near match on two leads enrolls neither and marks nothing (no guess about identity). Echoes on enrolled threads and our own API sends keep their current paths (owner message / in flight).
- S5 — Update the comment on `normalizeProspectText` (case was «deliberately untouched»: the exact path still is; the tolerant path is a separate, documented fallback).

## Tasks

- T1 — S2-S5: implement + tests in `test/`. Route: worker. Commit: —

## Log

- L1 (2026-11-26, Víctor): «También estoy viendo que escribimos demasiado formal, por ejemplo la exclamación inicial o la pregunta de interrogación inicial, casi nadie la escribe, así que vamos a empezar a no usarlas tanto, o al menos si yo modifico un poco el mensaje, que no te dé problemas para interpretar que a esa persona se le ha respondido, que a veces retoco algunas cosas.»
- L2 (2026-11-26, Víctor): deploy authorised once tests pass («Sí, despliega»); the parent deploys, not the worker.
- L3: review JD-A-001, JD-B-001, JD-B-002 fixed: name word required, uncomparable armed thread blocks, length prefilter + 20-candidate cap
