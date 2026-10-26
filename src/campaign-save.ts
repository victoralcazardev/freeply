import * as db from "./db";

/** The campaign fields the dashboard form and the JSON API both write. */
export type CampaignFields = Omit<db.Campaign, "id" | "linkId" | "createdAt" | "active"> & {
  active?: boolean;
};

export interface LinkChoice {
  /** Already normalized, or null for "leave the link alone". */
  targetUrl: string | null;
  /** Undefined keeps the current link's choice, or tracks a brand-new link. */
  tracked?: boolean;
  /** Detach the current link (wins over targetUrl). */
  remove?: boolean;
}

/**
 * Creates or updates a campaign together with its link. The one place link
 * minting lives, so the form routes and the API can't drift apart.
 *
 * Replaced links stay in the table with their click history. A destination
 * identical to the current one reuses the row — minting a new one every save is
 * what once left three short codes splitting one page's clicks.
 */
export async function saveCampaignWithLink(
  d1: D1Database,
  existing: db.Campaign | null,
  fields: CampaignFields,
  link: LinkChoice,
): Promise<db.Campaign> {
  let linkId = existing?.linkId ?? null;
  const currentLink = linkId ? await db.getLink(d1, linkId) : null;
  const tracked = link.tracked ?? currentLink?.tracked ?? true;

  if (link.remove) {
    linkId = null;
  } else if (link.targetUrl && currentLink && link.targetUrl === currentLink.targetUrl) {
    if (tracked !== currentLink.tracked) {
      await db.saveLink(d1, { ...currentLink, tracked });
    }
  } else if (link.targetUrl) {
    linkId = db.newId();
    await db.saveLink(d1, { id: linkId, code: db.newLinkCode(), targetUrl: link.targetUrl, tracked });
  }

  const campaign = {
    ...(existing ?? { createdAt: Date.now() }),
    ...fields,
    id: existing?.id ?? db.newId(),
    linkId,
    active: fields.active ?? existing?.active ?? true,
  } as db.Campaign;
  await db.saveCampaign(d1, campaign);
  return campaign;
}
