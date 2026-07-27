-- A campaign watches a list of keywords, not one. The list lives in `keywords`
-- as a JSON array; any of them fires the campaign, and dedupe still keys on the
-- campaign, so watching three words is still one message per commenter.
ALTER TABLE campaigns ADD COLUMN keywords TEXT NOT NULL DEFAULT '[]';

-- json_array escapes for us; concatenating quotes by hand corrupts any keyword
-- that contains one.
UPDATE campaigns SET keywords = json_array(keyword);

-- `keyword` is deliberately left in place, holding the first of the list. It is
-- NOT NULL, so dropping it means rebuilding the table on a live database, and
-- keeping it means a Worker deployed either side of this migration still reads
-- something true rather than an empty list.
