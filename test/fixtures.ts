/**
 * Values shared by the tests. Nothing here is real — see test/setup.ts, which
 * refuses to run if the worker under test is holding anything else.
 */

export const FIXTURE_SECRETS = {
  ENCRYPTION_KEY: "test-encryption-key",
  DASHBOARD_PASSWORD: "test-dashboard-password",
  META_APP_SECRET: "test-meta-app-secret",
  INSTAGRAM_APP_SECRET: "test-instagram-app-secret",
  META_VERIFY_TOKEN: "test-verify-token",
} as const;

/** Shaped like a real Instagram Business ID, which is what webhooks carry. */
export const IG_USER_ID = "17841400000000001";

/* ----------------------------------------------------------- user agents */

/**
 * Instagram's in-app browser, Android. The whole reason isCrawler exists in the
 * shape it does: an earlier version matched a bare "instagram" and silently
 * discarded every click from here — which is most of the traffic a DM link gets.
 */
export const UA_INSTAGRAM_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.122 " +
  "Mobile Safari/537.36 Instagram 341.0.0.28.109 Android " +
  "(34/14; 450dpi; 1080x2176; samsung; SM-S918B; dm3q; qcom; en_US; 632457142)";

/** Instagram's in-app browser, iOS — where no handoff is possible. */
export const UA_INSTAGRAM_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21F90 " +
  "Instagram 341.1.0.25.106 (iPhone15,3; iOS 17_5_1; en_US; en-US; " +
  "scale=3.00; 1290x2796; 632457142)";

/** Facebook's in-app browser — same problem, different app. */
export const UA_FACEBOOK_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21F90 " +
  "[FBAN/FBIOS;FBDV/iPhone15,3;FBMD/iPhone;FBSN/iOS;FBSV/17.5.1;FBSS/3;" +
  "FBID/phone;FBLC/en_US;FBOP/5]";

/** An ordinary browser, arriving from outside any app. */
export const UA_MOBILE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/** Meta's link-preview fetcher: runs when a DM containing a URL is displayed. */
export const UA_FACEBOOK_PREVIEW =
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
