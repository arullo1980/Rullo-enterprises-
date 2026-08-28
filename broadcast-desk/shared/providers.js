/**
 * OAuth provider configuration.
 *
 * Shared so the desktop app and the relay Worker build byte-identical
 * authorisation URLs — a redirect_uri or scope that differs between them is
 * the single most common reason a connection fails, and it fails confusingly.
 *
 * `redirect` on the platform catalogue decides which side runs the flow:
 *   loopback  the desktop app listens on http://127.0.0.1:PORT/callback
 *   https     the network refuses loopback, so the Worker takes the callback
 *             and the app collects the result from it
 */

export const PROVIDERS = {
  x: {
    authorize: "https://x.com/i/oauth2/authorize",
    token: "https://api.x.com/2/oauth2/token",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    pkce: true,
    basicAuth: true,
    me: async (fetchJson, token) => {
      const d = await fetchJson("https://api.x.com/2/users/me", { headers: { Authorization: `Bearer ${token}` } });
      return d && d.data ? { handle: d.data.username, remoteId: d.data.id, name: d.data.name } : {};
    },
  },
  reddit: {
    authorize: "https://www.reddit.com/api/v1/authorize",
    token: "https://www.reddit.com/api/v1/access_token",
    scopes: ["submit", "identity", "read", "history", "edit"],
    pkce: false,
    basicAuth: true,
    extraAuthParams: { duration: "permanent" },
    me: async (fetchJson, token, conn, ua) => {
      const d = await fetchJson("https://oauth.reddit.com/api/v1/me", {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": ua },
      });
      return { handle: d.name, remoteId: d.id };
    },
  },
  tumblr: {
    authorize: "https://www.tumblr.com/oauth2/authorize",
    token: "https://api.tumblr.com/v2/oauth2/token",
    scopes: ["basic", "write", "offline_access"],
    pkce: true,
    me: async (fetchJson, token) => {
      const d = await fetchJson("https://api.tumblr.com/v2/user/info", { headers: { Authorization: `Bearer ${token}` } });
      const user = d && d.response && d.response.user;
      const blog = user && (user.blogs || [])[0];
      return blog ? { handle: user.name, blogIdentifier: blog.name, blogUrl: blog.url } : {};
    },
  },
  vimeo: {
    authorize: "https://api.vimeo.com/oauth/authorize",
    token: "https://api.vimeo.com/oauth/access_token",
    scopes: ["public", "private", "upload", "edit", "video_files"],
    pkce: false,
    basicAuth: true,
    me: async (fetchJson, token) => {
      const d = await fetchJson("https://api.vimeo.com/me", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.vimeo.*+json;version=3.4" },
      });
      return { handle: d.name, remoteId: d.uri, name: d.name };
    },
  },
  mastodon: {
    dynamic: (instance) => ({
      authorize: `https://${instance}/oauth/authorize`,
      token: `https://${instance}/oauth/token`,
    }),
    scopes: ["read", "write:statuses", "write:media"],
    pkce: false,
    me: async (fetchJson, token, conn) => {
      const d = await fetchJson(`https://${conn.instance}/api/v1/accounts/verify_credentials`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return { handle: d.username, remoteId: d.id, name: d.display_name };
    },
  },

  /* ------------------------------- networks that refuse loopback redirects */

  facebook: {
    authorize: "https://www.facebook.com/v21.0/dialog/oauth",
    token: "https://graph.facebook.com/v21.0/oauth/access_token",
    scopes: ["pages_manage_posts", "pages_read_engagement", "pages_show_list", "business_management"],
    pkce: false,
    // A user token cannot post: swap it for the Page's own long-lived token.
    after: async (fetchJson, tokens) => {
      const d = await fetchJson(
        `https://graph.facebook.com/v21.0/me/accounts?access_token=${encodeURIComponent(tokens.access_token)}`);
      const pages = (d && d.data) || [];
      const page = pages[0];
      if (!page) return { pages: [] };
      return {
        pageId: page.id,
        pageToken: page.access_token,
        handle: page.name,
        pages: pages.map((p) => ({ id: p.id, name: p.name })),
      };
    },
  },
  instagram: {
    authorize: "https://www.instagram.com/oauth/authorize",
    token: "https://api.instagram.com/oauth/access_token",
    scopes: ["instagram_business_basic", "instagram_business_content_publish"],
    pkce: false,
    form: true,
    after: async (fetchJson, tokens) => {
      const d = await fetchJson(
        `https://graph.instagram.com/v21.0/me?fields=id,username&access_token=${encodeURIComponent(tokens.access_token)}`);
      return d && d.id ? { igUserId: d.id, remoteId: d.id, handle: d.username } : {};
    },
  },
  tiktok: {
    authorize: "https://www.tiktok.com/v2/auth/authorize/",
    token: "https://open.tiktokapis.com/v2/oauth/token/",
    scopes: ["video.publish", "video.upload", "user.info.basic"],
    pkce: true,
    clientKeyParam: "client_key",
    me: async (fetchJson, token) => {
      const d = await fetchJson("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const u = d && d.data && d.data.user;
      return u ? { handle: u.display_name, remoteId: u.open_id } : {};
    },
  },
  pinterest: {
    authorize: "https://www.pinterest.com/oauth/",
    token: "https://api.pinterest.com/v5/oauth/token",
    scopes: ["pins:read", "pins:write", "boards:read"],
    pkce: false,
    basicAuth: true,
    scopeSeparator: ",",
    me: async (fetchJson, token) => {
      const d = await fetchJson("https://api.pinterest.com/v5/user_account", {
        headers: { Authorization: `Bearer ${token}` },
      });
      return { handle: d.username, remoteId: d.id };
    },
  },
  linkedin: {
    authorize: "https://www.linkedin.com/oauth/v2/authorization",
    token: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["w_member_social", "openid", "profile"],
    pkce: false,
    me: async (fetchJson, token) => {
      const d = await fetchJson("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${token}` } });
      return { handle: d.name, remoteId: d.sub, name: d.name };
    },
  },
};

/** Endpoints for a provider, resolving the per-instance case (Mastodon). */
export function endpointsFor(platformId, instance) {
  const p = PROVIDERS[platformId];
  if (!p) throw new Error(`${platformId} does not use OAuth.`);
  if (p.dynamic) {
    if (!instance) throw new Error(`${platformId} needs an instance host.`);
    return p.dynamic(instance);
  }
  return { authorize: p.authorize, token: p.token };
}

/**
 * Build the authorisation URL. Identical on both sides of the product, so a
 * flow started in the app and finished at the relay cannot disagree.
 */
export function authorizeUrl(platformId, { clientId, redirectUri, state, challenge, instance, scopes }) {
  const p = PROVIDERS[platformId];
  const { authorize } = endpointsFor(platformId, instance);
  const params = new URLSearchParams({
    response_type: "code",
    redirect_uri: redirectUri,
    scope: (scopes || p.scopes).join(p.scopeSeparator || " "),
    state,
    ...(p.extraAuthParams || {}),
  });
  params.set(p.clientKeyParam || "client_id", clientId);
  if (challenge) {
    params.set("code_challenge", challenge);
    params.set("code_challenge_method", "S256");
  }
  return `${authorize}?${params}`;
}

/** The body and headers for the code-for-token exchange. */
export function tokenRequest(platformId, { clientId, clientSecret, code, redirectUri, verifier, refreshToken, userAgent }) {
  const p = PROVIDERS[platformId];
  const body = new URLSearchParams(
    refreshToken
      ? { grant_type: "refresh_token", refresh_token: refreshToken }
      : { grant_type: "authorization_code", code, redirect_uri: redirectUri }
  );
  if (verifier && !refreshToken) body.set("code_verifier", verifier);

  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (userAgent) headers["User-Agent"] = userAgent;
  if (p.basicAuth) {
    headers.Authorization = "Basic " + base64(`${clientId}:${clientSecret}`);
    body.set("client_id", clientId);
  } else {
    body.set(p.clientKeyParam || "client_id", clientId);
    if (clientSecret) body.set("client_secret", clientSecret);
  }
  return { headers, body };
}

function base64(s) {
  if (typeof btoa === "function") return btoa(s);
  return Buffer.from(s, "utf8").toString("base64");
}
