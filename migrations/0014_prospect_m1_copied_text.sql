-- The text "Copiar y registrar" registered, kept so the page can show it again.
--
-- The hash recognises the echo, but it cannot be rendered or handed to the
-- clipboard, and the draft the box started from may have been edited on the
-- phone before copying. The copy action writes this; "Reintentar" clears it
-- with the hash, because the text that was copied is no longer what is pending.
-- NULL on every row this migration finds: a thread copied before it existed
-- keeps its hash, and the collapsed "Copiados" section still shows the draft.
ALTER TABLE prospect_threads ADD COLUMN m1_copied_text TEXT;
